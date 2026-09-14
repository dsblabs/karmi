import { reply } from "@karmi/core/testing";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  BASE,
  connect,
  createThread,
  decodeEvents,
  frame,
  isEvent,
  isReply,
  message,
  postTurn,
  readSse,
  untilEvent,
} from "./helpers";
import { provider } from "./worker";

beforeEach(() => provider.script(() => "OK"));

const sse = (token: string, key: string, query = "", headers: Record<string, string> = {}) =>
  api(token, "GET", `/threads/${key}/events${query}`, undefined, {
    headers: { accept: "text/event-stream", ...headers },
  });

describe("Server-Sent Events", () => {
  it("replays the log from `after` and then streams a live Turn, one record per event with seq as id", async () => {
    provider.script([[reply.text("Hel", "lo")], "Again"]);
    const key = await createThread("alice");
    await postTurn("alice", key, "First");
    const first = await untilEvent("alice", key, "turn.completed", 1);

    const response = await sse("alice", key, "?after=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    await postTurn("alice", key, "Second");
    const records = await readSse(response, (event) => event.type === "turn.completed" && event.turn === 2);
    expect(records.map((record) => record.id)).toEqual(records.map((record) => record.event.seq));
    expect(records[0]!.event.seq).toBe(3);
    expect(records.slice(0, first.length - 2).map((record) => record.event)).toEqual(first.slice(2));
    expect(records.at(-1)!.event).toMatchObject({
      type: "turn.completed",
      turn: 2,
      message: [{ type: "text", text: "Again" }],
    });
  });

  it("resumes from Last-Event-ID and honours granularity", async () => {
    provider.script([[reply.text("a", "b", "c")]]);
    const key = await createThread("alice");
    await postTurn("alice", key, "Go");
    const all = await untilEvent("alice", key, "turn.completed");
    const response = await sse("alice", key, "?granularity=turn", { "last-event-id": "1" });
    const records = await readSse(response, (event) => event.type === "turn.completed");
    expect(records.map((record) => record.event.type)).not.toContain("message.delta");
    expect(records[0]!.event.seq).toBeGreaterThan(1);
    expect(records.at(-1)!.event).toEqual(all.at(-1));
  });
});

describe("WebSocket", () => {
  it("carries send, steer, cancel and approve frames in and the same event JSON out", async () => {
    provider.script([[reply.toolCall("book", { room: 2 })], "Booked."]);
    const key = await createThread("alice", "approver");
    const { socket, frames } = await connect("alice", key);
    socket.send(JSON.stringify({ id: "s1", type: "send", input: message("Book room 2") }));
    const sent = await frame(frames, isReply("s1"));
    expect(sent).toEqual({ type: "ack", id: "s1", result: { turn: 1, seq: 0 } });
    const requested = await frame(frames, isEvent("approval.requested"));

    socket.send(
      JSON.stringify({ id: 2, type: "approve", seq: requested.seq, answer: { decision: "allow", by: "alice" } }),
    );
    expect(await frame(frames, isReply(2))).toEqual({ type: "ack", id: 2, result: null });
    const completed = await frame(frames, isEvent("turn.completed"));
    expect(completed).toMatchObject({ turn: 1, message: [{ type: "text", text: "Booked." }] });

    socket.send(JSON.stringify({ id: 3, type: "approve", seq: requested.seq, answer: { decision: "deny" } }));
    expect(await frame(frames, isReply(3))).toMatchObject({
      type: "error",
      id: 3,
      error: { code: "approval.resolved" },
    });

    // The socket's frames are byte-for-byte the persisted log.
    const log = decodeEvents(await (await api("alice", "GET", `/threads/${key}/events`)).json());
    const streamed = frames.filter((value) => typeof (value as { seq?: unknown }).seq === "number");
    expect(streamed).toEqual(log);

    socket.send("not json");
    expect(
      await frame(
        frames,
        (value): value is { type: "error"; error: { code: string } } =>
          isReply(undefined)(value) && value.type === "error",
      ),
    ).toMatchObject({ error: { code: "http.badRequest" } });
    socket.send(JSON.stringify({ id: 4, type: "cancel" }));
    expect(await frame(frames, isReply(4))).toEqual({ type: "ack", id: 4, result: null });
    socket.close(1000, "done");
  });

  it("steers a running Turn and replays after a reconnect from a seq", async () => {
    provider.script([[reply.toolCall("book", { room: 9 })], "Booked nine."]);
    const key = await createThread("alice", "approver");
    const { socket, frames } = await connect("alice", key);
    socket.send(JSON.stringify({ id: 1, type: "send", input: message("Book room 9") }));
    await frame(frames, isEvent("turn.paused"));
    socket.send(JSON.stringify({ id: 2, type: "steer", input: message("Actually, hurry") }));
    expect(await frame(frames, isReply(2))).toMatchObject({ type: "ack", id: 2 });
    socket.close(1000, "dropped");

    const paused = frames.filter(isEvent("turn.paused"))[0]!;
    const again = await connect("alice", key, `&after=${paused.seq}`);
    const request = frames.filter(isEvent("approval.requested"))[0]!;
    again.socket.send(JSON.stringify({ id: 3, type: "approve", seq: request.seq, answer: { decision: "allow" } }));
    const completed = await frame(again.frames, isEvent("turn.completed"));
    const replayed = again.frames.filter(
      (value): value is { seq: number } => typeof (value as { seq?: unknown }).seq === "number",
    );
    expect(replayed.every((event) => event.seq > paused.seq)).toBe(true);
    expect(completed.seq).toBeGreaterThan(paused.seq);
    again.socket.close(1000, "done");
  });

  it("refuses an unauthenticated or foreign upgrade before opening a socket", async () => {
    const key = await createThread("alice");
    const anonymous = await SELF.fetch(`${BASE}/threads/${key}`, { headers: { upgrade: "websocket" } });
    expect(anonymous.status).toBe(401);
    const foreign = await SELF.fetch(`${BASE}/threads/${key}?token=bob`, { headers: { upgrade: "websocket" } });
    expect(foreign.status).toBe(404);
  });
});
