import type { ThreadEvent } from "@karmi/core";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TRANSPORT_REQUESTS, TRANSPORTS } from "../src/transports";
import { api, events } from "./client";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

// These tests use the patterns of the REST, stream and socket tests of @karmi/http, through the routes of the
// Playground. The browser sends the same requests and frames.

const BASE = "https://playground.test";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The test reads each frame and record through one function, which checks that it is a Thread event.
function decodeEvent(value: unknown): ThreadEvent {
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.type !== "string")
    throw new Error("Not a Thread event.");
  const event: unknown = value;
  return event as ThreadEvent;
}

function decodeState(value: unknown): { threadKey: string } {
  if (!isRecord(value) || typeof value.threadKey !== "string") throw new Error("Not a scenario state.");
  return { threadKey: value.threadKey };
}

const reset = async () =>
  decodeState(await (await api(TOKEN, "POST", `/api/scenarios/${TRANSPORTS}/reset`)).json()).threadKey;

const message = (text: string) => ({ kind: "message", parts: [{ type: "text", text }] });

async function until(key: string, type: ThreadEvent["type"], turn?: number): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(
      async () =>
        (log = await events(key)).some((event) => event.type === type && (turn === undefined || event.turn === turn)),
      { timeout: 10_000 },
    )
    .toBe(true);
  return log;
}

/** Sends a prompt through the REST route and waits for the end of its Turn. */
async function runTurn(key: string, text: string, turn: number): Promise<ThreadEvent[]> {
  expect((await api(TOKEN, "POST", `/threads/${key}/turns`, message(text))).status).toBe(202);
  return until(key, "turn.completed", turn);
}

/** Reads the records of an SSE body until the record whose event satisfies `until`. */
async function readSse(response: Response, last: (event: ThreadEvent) => boolean) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("The answer has no body.");
  const records: { id: number; event: ThreadEvent }[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return records;
    buffer += value;
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (record.startsWith(":")) continue;
      const event = decodeEvent(JSON.parse(/^data: (.*)$/m.exec(record)?.[1] ?? "null"));
      records.push({ id: Number(/^id: (\d+)$/m.exec(record)?.[1]), event });
      if (last(event)) {
        await reader.cancel();
        return records;
      }
    }
  }
}

/** Opens the WebSocket of a Thread with the token in the query, as a browser does, and collects each frame. */
async function connect(key: string, query = "") {
  const response = await SELF.fetch(`${BASE}/threads/${key}?token=${TOKEN}${query}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("The answer has no WebSocket.");
  const frames: Record<string, unknown>[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data));
    if (isRecord(value)) frames.push(value);
  });
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  return { socket, frames, closed };
}

async function frame(frames: Record<string, unknown>[], match: (frame: Record<string, unknown>) => boolean) {
  await expect.poll(() => frames.some(match), { timeout: 10_000 }).toBe(true);
  return frames.find(match);
}

const seqs = (frames: Record<string, unknown>[]) =>
  frames.flatMap((value) => (typeof value.seq === "number" ? [value.seq] : []));

beforeEach(() => provider.script(({ index }) => `Answer ${String(index + 1)}.`));

describe("the guided REST requests", () => {
  it.each(TRANSPORT_REQUESTS.map((request) => [request.label, request] as const))(
    "%s gets the status and the error code that the page tells",
    async (_label, request) => {
      const key = await reset();
      await runTurn(key, "Hello", 1);
      const response = await api(
        request.token ? TOKEN : null,
        request.method,
        request.path.replace("{key}", key),
        request.body,
      );
      expect(response.status).toBe(request.status);
      const body: unknown = await response.json();
      if (request.code) expect(body).toEqual({ error: { code: request.code, message: expect.any(String) } });
      else expect(JSON.stringify(body)).not.toContain('"error"');
    },
  );
});

describe("Server-Sent Events", () => {
  it("replays the events after a seq, then streams the next Turn with the seq as the record id", async () => {
    const key = await reset();
    const first = await runTurn(key, "First", 1);
    const stream = await SELF.fetch(`${BASE}/threads/${key}/events?after=2&token=${TOKEN}`, {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect((await api(TOKEN, "POST", `/threads/${key}/turns`, message("Second"))).status).toBe(202);
    const records = await readSse(stream, (event) => event.type === "turn.completed" && event.turn === 2);
    expect(records.map((record) => record.id)).toEqual(records.map((record) => record.event.seq));
    expect(records.slice(0, first.length - 2).map((record) => record.event)).toEqual(first.slice(2));
    expect(records.at(-1)?.event).toMatchObject({ turn: 2, message: [{ type: "text", text: "Answer 2." }] });
  });

  it("continues after Last-Event-ID, as an EventSource does after a disconnect", async () => {
    const key = await reset();
    const log = await runTurn(key, "First", 1);
    const stream = await SELF.fetch(`${BASE}/threads/${key}/events?token=${TOKEN}`, {
      headers: { accept: "text/event-stream", "last-event-id": "1" },
    });
    const records = await readSse(stream, (event) => event.type === "turn.completed");
    expect(records.map((record) => record.event)).toEqual(log.slice(1));
  });
});

describe("the WebSocket of the Thread", () => {
  it("takes a send frame, answers with an ack and sends the events of the Turn on the same socket", async () => {
    const key = await reset();
    const { socket, frames } = await connect(key);
    socket.send(JSON.stringify({ id: 1, type: "send", input: message("Hello") }));
    expect(await frame(frames, (value) => value.id === 1)).toEqual({
      type: "ack",
      id: 1,
      result: { turn: 1, seq: 0 },
    });
    await frame(frames, (value) => value.type === "turn.completed");
    expect(frames.filter((value) => typeof value.seq === "number")).toEqual(await events(key));
    socket.close(1000, "done");
  });

  it("replays only the events after the seq of a reconnect", async () => {
    const key = await reset();
    const first = await runTurn(key, "First", 1);
    const last = first.at(-1)?.seq ?? 0;
    // The page dropped its stream after the first Turn. The second Turn runs without a Subscriber.
    await runTurn(key, "Second", 2);
    const { socket, frames } = await connect(key, `&after=${String(last)}`);
    await frame(frames, (value) => value.type === "turn.completed" && value.turn === 2);
    const replayed = seqs(frames);
    expect(replayed[0]).toBe(last + 1);
    expect(replayed.every((seq) => seq > last)).toBe(true);
    socket.close(1000, "done");
  });

  it("closes with 4004 when a reset deletes the Thread", async () => {
    const key = await reset();
    const { closed } = await connect(key);
    await reset();
    expect((await closed).code).toBe(4004);
  });
});

describe("GET /api/recording", () => {
  it("tells how to start a recording when the Worker records nothing", async () => {
    const answer = await api(TOKEN, "GET", "/api/recording");
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "playground.notRecording" } });
  });
});
