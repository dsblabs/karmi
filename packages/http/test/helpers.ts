import type { ThreadEvent } from "@karmi/core";
import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const BASE = "https://karmi.test";

/** Fetches through the test Worker as `token`, with a JSON body when `body` is given. */
export function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

let n = 0;
/** Creates a fresh Thread for `agent` as `token` and returns its key. `threadId` names it, for a test that reads its storage. */
export async function createThread(
  token: string,
  agent = "concierge",
  threadId = `t${++n}-${Date.now()}`,
): Promise<string> {
  const response = await api(token, "POST", "/threads", { agent, threadId });
  expect(response.status).toBe(201);
  const { key } = decodeResource(await response.json());
  return key;
}

const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
export { message };

/** Posts a JSON Turn and returns `{ turn, seq }`. */
export async function postTurn(
  token: string,
  key: string,
  text: string,
  steer = false,
): Promise<{ turn: number; seq: number }> {
  const response = await api(token, "POST", `/threads/${key}/turns`, { ...message(text), steer });
  expect(response.status).toBe(202);
  return decodeReceipt(await response.json());
}

/** Waits until the Thread's log holds an event of `type` in `turn`, then returns the whole log. */
export async function untilEvent(token: string, key: string, type: string, turn?: number): Promise<ThreadEvent[]> {
  let events: ThreadEvent[] = [];
  await expect
    .poll(
      async () => {
        events = decodeEvents(await (await api(token, "GET", `/threads/${key}/events`)).json());
        return events.some((event) => event.type === type && (turn === undefined || event.turn === turn));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return events;
}

/** Splits an SSE body into `{ id, data }` records, ending after the event that satisfies `until`. */
export async function readSse(
  response: Response,
  until: (event: ThreadEvent) => boolean,
): Promise<{ id: number; event: ThreadEvent }[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const records: { id: number; event: ThreadEvent }[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      if (record.startsWith(":")) continue;
      const id = Number(/^id: (\d+)$/m.exec(record)?.[1]);
      const event = decodeEvent(JSON.parse(/^data: (.*)$/m.exec(record)?.[1] ?? "null"));
      records.push({ id, event });
      if (until(event)) {
        await reader.cancel();
        return records;
      }
    }
  }
  return records;
}

/** Opens a WebSocket on the Thread and collects every frame into `frames`. */
export async function connect(
  token: string,
  key: string,
  query = "",
): Promise<{ socket: WebSocket; frames: unknown[]; closed: Promise<CloseEvent> }> {
  const response = await SELF.fetch(`${BASE}/threads/${key}?token=${token}${query}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: unknown[] = [];
  socket.accept();
  socket.addEventListener("message", (message) => frames.push(JSON.parse(String(message.data))));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  return { socket, frames, closed };
}

/** Waits until `frames` holds a frame matching `predicate` and returns it. */
export async function frame<T>(frames: unknown[], predicate: (frame: unknown) => frame is T): Promise<T> {
  await expect.poll(() => frames.some(predicate), { timeout: 10_000 }).toBe(true);
  return frames.filter(predicate)[0]!;
}

export const isEvent =
  (type: string, turn?: number) =>
  (value: unknown): value is ThreadEvent =>
    isRecord(value) && value.type === type && (turn === undefined || value.turn === turn);
export const isReply =
  (id: unknown) =>
  (value: unknown): value is { type: "ack" | "error"; id: unknown; result?: unknown; error?: { code: string } } =>
    isRecord(value) && (value.type === "ack" || value.type === "error") && value.id === id;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The test reads the Worker's JSON back through the same narrowing every time, in one place per shape.
export function decodeResource(value: unknown): {
  key: string;
  agent: string;
  user?: string;
  threadId: string;
  status: { state: string; seq: number };
} {
  if (!isRecord(value) || typeof value.key !== "string" || !isRecord(value.status))
    throw new Error("Not a Thread resource.");
  return value as {
    key: string;
    agent: string;
    user?: string;
    threadId: string;
    status: { state: string; seq: number };
  };
}
export function decodeReceipt(value: unknown): { turn: number; seq: number } {
  if (!isRecord(value) || typeof value.turn !== "number" || typeof value.seq !== "number")
    throw new Error("Not a receipt.");
  return { turn: value.turn, seq: value.seq };
}
export function decodeEvents(value: unknown): ThreadEvent[] {
  if (!Array.isArray(value)) throw new Error("Not an event list.");
  return value.map(decodeEvent);
}
export function decodeEvent(value: unknown): ThreadEvent {
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.type !== "string")
    throw new Error("Not a Thread event.");
  const event: unknown = value;
  return event as ThreadEvent;
}
export function decodeError(value: unknown): { code: string; message: string } {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string")
    throw new Error("Not an error body.");
  return value.error as { code: string; message: string };
}
