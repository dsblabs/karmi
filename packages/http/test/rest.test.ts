import { reply } from "@karmi/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  BASE,
  createThread,
  decodeError,
  decodeEvents,
  decodeResource,
  message,
  postTurn,
  untilEvent,
} from "./helpers";
import { provider } from "./worker";
import { SELF } from "cloudflare:test";

beforeEach(() => provider.script(() => "OK"));

describe("authentication", () => {
  it("answers 401 when the callback returns null and never touches a Thread", async () => {
    const response = await api(null, "POST", "/threads", { agent: "concierge" });
    expect(response.status).toBe(401);
    expect(decodeError(await response.json())).toEqual({
      code: "http.unauthorized",
      message: "Authentication required.",
    });
  });

  it("leaves paths outside /threads to the Worker", async () => {
    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(404);
  });
});

describe("threads", () => {
  it("creates a Thread for the Principal's User and reads it back by key", async () => {
    const created = await api("alice", "POST", "/threads", { agent: "concierge", threadId: "welcome" });
    expect(created.status).toBe(201);
    const resource = decodeResource(await created.json());
    expect(resource).toMatchObject({
      agent: "concierge",
      user: "alice",
      threadId: "welcome",
      status: { state: "idle", seq: 0 },
    });

    const read = await api("alice", "GET", `/threads/${resource.key}`);
    expect(read.status).toBe(200);
    expect(decodeResource(await read.json())).toEqual(resource);
  });

  it("mints a threadId when the body names none and a service Principal owns user-less Threads", async () => {
    const created = decodeResource(await (await api("service", "POST", "/threads", { agent: "concierge" })).json());
    expect(created.user).toBeUndefined();
    expect(created.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hides another User's Thread and a malformed key behind a 404", async () => {
    const key = await createThread("alice");
    expect((await api("bob", "GET", `/threads/${key}`)).status).toBe(404);
    expect((await api("service", "GET", `/threads/${key}`)).status).toBe(404);
    const malformed = await api("alice", "GET", "/threads/not-a-key");
    expect(malformed.status).toBe(404);
    expect(decodeError(await malformed.json()).code).toBe("thread.key.invalid");
  });

  it("lists the Principal's Threads of one Agent", async () => {
    const key = await createThread("bob");
    await postTurn("bob", key, "Hi");
    await untilEvent("bob", key, "turn.completed");
    const listed = await api("bob", "GET", "/threads?agent=concierge");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      expect.objectContaining({ key, agent: "concierge", user: "bob", title: "Hi" }),
    ]);
    expect((await api("bob", "GET", "/threads")).status).toBe(400);
  });

  it("rejects a malformed body with the path of the first issue", async () => {
    const response = await api("alice", "POST", "/threads", { agent: 7 });
    expect(response.status).toBe(400);
    expect(decodeError(await response.json()).message).toMatch(/^Invalid thread request at agent:/);
    const notJson = await SELF.fetch(`${BASE}/threads`, {
      method: "POST",
      headers: { authorization: "Bearer alice", "content-type": "text/plain" },
      body: "x",
    });
    expect(notJson.status).toBe(415);
    expect((await api("alice", "PUT", "/threads")).status).toBe(405);
  });
});

describe("turns", () => {
  it("runs a JSON Turn and serves the log as JSON when the client does not ask for a stream", async () => {
    provider.script([[reply.text("Wel", "come!")]]);
    const key = await createThread("alice");
    const receipt = await postTurn("alice", key, "Hello");
    expect(receipt).toEqual({ turn: 1, seq: 0 });
    const events = await untilEvent("alice", key, "turn.completed");
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "step.started",
      "message.delta",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    const after = decodeEvents(await (await api("alice", "GET", `/threads/${key}/events?after=7`)).json());
    expect(after.map((event) => event.seq)).toEqual([8]);
  });

  it("uploads multipart files to the Thread and sends them as media Parts in posted order", async () => {
    const key = await createThread("alice");
    const form = new FormData();
    form.append("text", "What is this?");
    form.append(
      "file",
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])],
        "pixel.png",
        { type: "image/png" },
      ),
    );
    form.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    form.append("channelRef", JSON.stringify({ tab: 3 }));
    const response = await api("alice", "POST", `/threads/${key}/turns`, undefined, { body: form });
    expect(response.status).toBe(202);
    const events = await untilEvent("alice", key, "turn.completed");
    const started = events.find((event) => event.type === "turn.started");
    expect(started).toMatchObject({
      channelRef: { tab: 3 },
      input: {
        kind: "message",
        parts: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            mimeType: "image/png",
            name: "pixel.png",
            media: { mimeType: "image/png", bytes: 16, name: "pixel.png" },
          },
          { type: "file", mimeType: "text/plain", name: "notes.txt", media: { bytes: 5 } },
        ],
      },
    });
    const empty = await api("alice", "POST", `/threads/${key}/turns`, undefined, { body: new FormData() });
    expect(empty.status).toBe(400);
  });

  it("maps karmi errors to statuses: 404 for a Thread that was never created, 400 for a seq past the log", async () => {
    // A key is the base64url of [agent, user, threadId]; this one names a Thread nobody created.
    const never = btoa(JSON.stringify(["concierge", "alice", "never-created"])).replaceAll("=", "");
    const missing = await api("alice", "POST", `/threads/${never}/turns`, message("x"));
    expect(missing.status).toBe(404);
    expect(decodeError(await missing.json()).code).toBe("thread.notFound");
    const key = await createThread("alice");
    const tooFar = await api("alice", "GET", `/threads/${key}/events?after=5`);
    expect(tooFar.status).toBe(400);
    expect((await api("alice", "GET", `/threads/${key}/events?after=-1`)).status).toBe(400);
    expect((await api("alice", "GET", `/threads/${key}/events?granularity=word`)).status).toBe(400);
  });
});

describe("approvals, cancel and compact", () => {
  it("answers an Approval once, then 409s a second answer and 404s an unknown seq", async () => {
    provider.script([[reply.toolCall("book", { room: 7 })], "Booked."]);
    const key = await createThread("alice", "approver");
    await postTurn("alice", key, "Book room 7");
    const parked = await untilEvent("alice", key, "turn.paused");
    const request = parked.find((event) => event.type === "approval.requested")!;
    const answered = await api("alice", "POST", `/threads/${key}/approvals/${request.seq}`, {
      decision: "allow",
      by: "alice",
    });
    expect(answered.status).toBe(204);
    const events = await untilEvent("alice", key, "turn.completed");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "approval.resolved", request: request.seq, decision: "allow", by: "alice" }),
    );

    const again = await api("alice", "POST", `/threads/${key}/approvals/${request.seq}`, { decision: "deny" });
    expect(again.status).toBe(409);
    expect(decodeError(await again.json()).code).toBe("approval.resolved");
    const unknown = await api("alice", "POST", `/threads/${key}/approvals/999`, { decision: "deny" });
    expect(unknown.status).toBe(404);
    expect(decodeError(await unknown.json()).code).toBe("approval.notFound");
    expect((await api("alice", "POST", `/threads/${key}/approvals/x`, { decision: "deny" })).status).toBe(404);
    const invalid = await api("alice", "POST", `/threads/${key}/approvals/${request.seq}`, { decision: "maybe" });
    expect(invalid.status).toBe(400);
  });

  it("cancels a parked Turn and refuses to compact a busy Thread", async () => {
    provider.script([[reply.toolCall("book", { room: 1 })]]);
    const key = await createThread("alice", "approver");
    await postTurn("alice", key, "Book");
    await untilEvent("alice", key, "turn.paused");
    const busy = await api("alice", "POST", `/threads/${key}/compact`);
    expect(busy.status).toBe(409);
    expect(decodeError(await busy.json()).code).toBe("thread.busy");
    expect((await api("alice", "POST", `/threads/${key}/cancel`)).status).toBe(204);
    const events = await untilEvent("alice", key, "turn.failed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", reason: "cancelled" }));
    expect((await api("alice", "POST", `/threads/${key}/compact`)).status).toBe(204);
    expect((await api("alice", "POST", `/threads/${key}/compact`, { instructions: 7 })).status).toBe(400);
  });
});
