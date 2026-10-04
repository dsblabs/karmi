import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { keys } from "../src/keys";
import { expect, it } from "vitest";
import { reply } from "../src/testing/index";
import { karmi, provider, clock } from "./worker";
import type { ThreadEvent } from "../src/index";
import { decodeSocketAttachment } from "../src/thread-sockets";

it("returns a socket that receives a running Turn", async () => {
  provider.script(["Hello"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-live" });
  const response = await thread.socket();
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const events: ThreadEvent[] = [];
  socket.addEventListener("message", (message) => {
    events.push(JSON.parse(String(message.data)));
  });
  socket.accept();
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Hi" }] });
  await expect.poll(() => events.at(-1)?.type).toBe("turn.completed");
  expect(events).toEqual(await thread.events());
  socket.close();
});

it("keeps the socket and its authority after the in-memory instance hibernates", async () => {
  provider.script(["After eviction"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-abort" });
  const socket = (await thread.socket({ granularity: "turn" })).webSocket!;
  const frames: unknown[] = [];
  socket.addEventListener("message", (message) => {
    frames.push(JSON.parse(String(message.data)));
  });
  socket.accept();
  const stub = env.KARMI_THREADS.getByName(keys.thread("test", "socket-abort"));
  await evictDurableObject(stub, { webSockets: "hibernate" });
  socket.send(
    JSON.stringify({ type: "send", id: 1, input: { kind: "message", parts: [{ type: "text", text: "Hi" }] } }),
  );
  await expect.poll(() => frames).toContainEqual(expect.objectContaining({ type: "turn.completed" }));

  expect(frames).not.toContainEqual(expect.objectContaining({ type: "message.delta" }));
  socket.close();
});

it("records the `by` bound at upgrade on an approve frame, also after the socket hibernates", async () => {
  provider.script([[reply.toolCall("book", { room: 7 }, "c1")], "Booked"]);
  const thread = karmi.scope("test").thread({ agent: "asking", threadId: "socket-by" });
  const socket = (await thread.socket({ by: "alice" })).webSocket!;
  const frames: unknown[] = [];
  socket.addEventListener("message", (message) => {
    frames.push(JSON.parse(String(message.data)));
  });
  socket.accept();
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Book room 7" }] });
  await expect.poll(() => frames).toContainEqual(expect.objectContaining({ type: "turn.paused" }));
  const seq = (await thread.status()).pendingApprovals![0]!.seq;
  await evictDurableObject(env.KARMI_THREADS.getByName(keys.thread("test", "socket-by")), { webSockets: "hibernate" });

  socket.send(JSON.stringify({ id: 1, type: "approve", seq, answer: { decision: "allow", by: "mallory" } }));
  await expect
    .poll(() => frames)
    .toContainEqual({ type: "error", error: expect.objectContaining({ code: "http.badRequest" }) });
  expect((await thread.status()).pendingApprovals).toMatchObject([{ seq }]);

  socket.send(JSON.stringify({ id: 2, type: "approve", seq, answer: { decision: "allow" } }));
  await expect
    .poll(() => frames)
    .toContainEqual(expect.objectContaining({ type: "approval.resolved", request: seq, by: "alice" }));
  // The resumed Turn must end before the next test scripts the Provider.
  await expect.poll(() => frames).toContainEqual(expect.objectContaining({ type: "turn.completed" }));
  socket.close();
});

it("decodes a stored socket attachment that has no `by`", () => {
  const stored = { address: { scope: "test", agent: "asking", threadId: "old", create: false }, granularity: "part" };
  expect(decodeSocketAttachment(stored)).toEqual(stored);
  expect(decodeSocketAttachment({ ...stored, by: "alice" })).toEqual({ ...stored, by: "alice" });
});

it("streams from the head by default and replays explicitly in seq order", async () => {
  provider.script(["Old", "New"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-replay" });
  await thread.send({ kind: "message", parts: [{ type: "text", text: "First" }] });
  await expect.poll(async () => (await thread.events()).at(-1)?.type).toBe("turn.completed");
  const head = (await thread.status()).seq;
  const live = (await thread.socket()).webSocket!;
  const replay = (await thread.socket({ after: 2 })).webSocket!;
  const liveEvents: ThreadEvent[] = [];
  const replayEvents: ThreadEvent[] = [];
  live.addEventListener("message", (event) => {
    liveEvents.push(JSON.parse(String(event.data)));
  });
  replay.addEventListener("message", (event) => {
    replayEvents.push(JSON.parse(String(event.data)));
  });
  live.accept();
  replay.accept();
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Second" }] });
  await expect.poll(() => liveEvents.at(-1)?.type).toBe("turn.completed");
  await expect.poll(() => replayEvents.at(-1)?.turn).toBe(2);
  expect(liveEvents).toEqual(await thread.events({ after: head }));
  expect(replayEvents).toEqual(await thread.events({ after: 2 }));
  live.close();
  replay.close();
});

it("closes a deleted Thread with terminal code 4004", async () => {
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-delete" });
  const socket = (await thread.socket()).webSocket!;
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.accept();
  await thread.delete();
  expect(await closed).toBe(4004);
  await expect(thread.socket()).rejects.toMatchObject({ code: "thread.deleted" });
});

it("refuses more than 64 sockets and releases capacity after disconnection", async () => {
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-cap" });
  const sockets: WebSocket[] = [];
  for (let i = 0; i < 64; i++) {
    const socket = (await thread.socket()).webSocket!;
    socket.accept();
    sockets.push(socket);
  }
  await expect(thread.socket()).rejects.toMatchObject({ code: "thread.socketLimit" });
  for (const socket of sockets) socket.close();
  await expect
    .poll(async () => {
      try {
        const socket = (await thread.socket()).webSocket!;
        socket.accept();
        socket.close();
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
});

it("replays missed events after an abort closes the socket with a transient code", async () => {
  provider.script(["Recovered"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-abort-replay" });
  const socket = (await thread.socket()).webSocket!;
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.accept();
  const after = (await thread.status()).seq;
  await expect(
    runInDurableObject(env.KARMI_THREADS.getByName(keys.thread("test", "socket-abort-replay")), (_, state) =>
      state.abort("socket recovery test"),
    ),
  ).rejects.toThrow();
  expect(await closed).toBe(1006);
  const reopened = karmi.scope("test").thread(thread.key);
  await reopened.send({ kind: "message", parts: [{ type: "text", text: "Hi" }] });
  const events: ThreadEvent[] = [];
  for await (const event of reopened.subscribe({ after })) {
    events.push(event);
    if (event.type === "turn.completed") break;
  }
  expect(events).toEqual(await reopened.events());
});

it("replays multiple pages without losing events or seq order", async () => {
  provider.script([[reply.text(...Array.from({ length: 300 }, () => "a"))]]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-pages" });
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  await expect.poll(async () => (await thread.events()).at(-1)?.type).toBe("turn.completed");
  const received: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: 0 })) {
    received.push(event);
    if (event.type === "turn.completed") break;
  }
  expect(received.length).toBeGreaterThan(256);
  expect(received).toEqual(await thread.events());
});

it("ends an idle subscription immediately when its consumer returns", async () => {
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "socket-return" });
  const iterator = thread.subscribe()[Symbol.asyncIterator]();
  const pending = iterator.next();
  await iterator.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
});

it("closes sockets when their Scope is destroyed", async () => {
  const tenant = karmi.scope("socket-destroy-scope");
  const thread = tenant.thread({ agent: "concierge", threadId: "attached" });
  const socket = (await thread.socket()).webSocket!;
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.accept();
  await tenant.destroy();
  await clock.advance(1000);
  expect(await closed).toBe(4004);
});
