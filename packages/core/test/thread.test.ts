import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/index";
import { lastMessage, reply } from "../src/testing/index";
import { provider, scope } from "./worker";

// Storage is shared across the file, so each test uses a Thread of its own.
let n = 0;
const fresh = (identity: { agent?: string; user?: string } = { user: "guest-1" }) =>
  scope.thread({ agent: "concierge", threadId: `t${++n}`, ...identity });
const message = (text: string, channelRef?: unknown) => ({
  kind: "message" as const,
  parts: [{ type: "text" as const, text }],
  ...(channelRef !== undefined && { channelRef }),
});

describe("one text Turn", () => {
  it("runs one model Step end-to-end and logs the whole Turn in seq order", async () => {
    provider.script([[reply.text("Wel", "come!"), reply.usage({ input: 10, output: 2 })]]);
    const thread = fresh();
    const events = await thread.send(message("Hello there"));
    expect(events).toHaveSequence([
      "turn.started",
      "step.started",
      "message.delta",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events).toContainEvent({
      type: "step.started",
      kind: "model",
      n: 1,
      attempt: 1,
      model: "anthropic/claude-sonnet-5",
      provider: "fake",
      agentVersion: 1,
    });
    expect(events).toContainEvent({
      type: "step.completed",
      stopReason: "end_turn",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    expect(events).toContainEvent({
      type: "turn.completed",
      stopReason: "end_turn",
      message: [{ type: "text", text: "Welcome!" }],
    });
    expect(lastMessage(events)).toBe("Welcome!");

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      model: "claude-sonnet-5",
      config: { adapter: "fake" },
      system: "Help the guest.\n\nYou serve guest-1 at The Grand.\n\nYou are Claude.",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello there" }] }],
    });
  });
});

describe("Provider call options", () => {
  it("hands the adapter the Scope's scopedFetch, the Turn's attribution and a Logger", async () => {
    provider.script(async ({ options }) => {
      const blocked = await options.fetch("http://169.254.169.254/latest/meta-data");
      return JSON.stringify({
        attribution: options.attribution,
        logger: typeof options.logger?.warn,
        blocked: blocked.status,
        aborted: options.signal.aborted,
      });
    });
    const events = await fresh().send(message("probe"));
    expect(JSON.parse(lastMessage(events)!)).toEqual({
      attribution: { scope: "test", agent: "concierge", thread: `t${n}`, turn: 1 },
      logger: "function",
      blocked: 403,
      aborted: false,
    });
  });
});

describe("Turn input", () => {
  it("echoes channelRef on every event of the Turn", async () => {
    provider.script(["Hi"]);
    const ref = { chat: "c1", message: 42 };
    const events = await fresh().send(message("Hello", ref));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.channelRef).toEqual(ref);
  });

  it("shows an Event input to the model through the Event Fragment, with no User", async () => {
    provider.script(["Noted"]);
    const events = await fresh({}).send({ kind: "event", type: "booking.created", payload: { room: 12 } });
    expect(events).toContainEvent({ type: "turn.completed", stopReason: "end_turn" });
    expect(provider.requests[0]).toMatchObject({
      system: "Help the guest.\n\nYou serve the front desk at The Grand.\n\nYou are Claude.",
      messages: [{ role: "user", content: [{ type: "text", text: 'Event "booking.created":\n{"room":12}' }] }],
    });
  });

  it("carries the whole transcript into the next Turn", async () => {
    provider.script(["First", "Second"]);
    const thread = fresh();
    await thread.send(message("One"));
    const events = await thread.send(message("Two"));
    expect(events[0]).toMatchObject({ type: "turn.started", turn: 2, seq: 8 });
    expect(lastMessage(events)).toBe("Second");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "One" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        provider: "fake",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
      },
      { role: "user", content: [{ type: "text", text: "Two" }] },
    ]);
  });
});

describe("reading the log", () => {
  it("reports status from the log head and sums usage across Turns", async () => {
    provider.script([
      [reply.text("a"), reply.usage({ input: 5, output: 1 })],
      [reply.text("b"), reply.usage({ input: 7, output: 2 })],
    ]);
    const thread = fresh();
    expect(await thread.status()).toEqual({
      state: "idle",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      seq: 0,
    });
    await thread.send(message("One"));
    await thread.send(message("Two"));
    expect(await thread.status()).toEqual({
      state: "idle",
      agentVersion: 1,
      usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
      seq: 14,
    });
  });

  it("replays events after a seq and subscribes at part or turn granularity", async () => {
    provider.script([[reply.text("Hel", "lo")]]);
    const thread = fresh();
    await thread.send(message("Hi"));
    const all = await thread.events();
    expect(all.map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "message.delta",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    expect((await thread.events({ after: 5 })).map((e) => e.seq)).toEqual([6, 7, 8]);

    const parts = await take(thread.subscribe({ granularity: "part" }), 6);
    expect(parts.map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    const turns = await take(thread.subscribe({ granularity: "turn", after: 1 }), 4);
    expect(turns.map((e) => e.type)).toEqual(["step.started", "usage.recorded", "step.completed", "turn.completed"]);
  });

  it("streams live events to a subscriber that attached before the Turn", async () => {
    provider.script(["Live"]);
    const thread = fresh();
    const seen = take(thread.subscribe({ granularity: "turn" }), 5);
    await thread.send(message("Go"));
    expect((await seen).map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
  });
});

async function take<T>(source: AsyncIterable<T>, count: number): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
    if (items.length === count) break;
  }
  return items;
}

describe("Thread identity", () => {
  it("reopens a Thread from its key, never creates from a bare key, and refuses another identity", async () => {
    provider.script(["Hi"]);
    const thread = fresh();
    await thread.send(message("Hello"));
    const reopened = scope.thread(thread.key);
    expect(reopened.key).toBe(thread.key);
    expect((await reopened.events()).length).toBe(7);

    const unknown = scope.thread(scope.thread({ agent: "concierge", user: "guest-1", threadId: "never-sent" }).key);
    await expect(unknown.status()).rejects.toMatchObject({ code: "thread.notFound" });
    await expect(
      scope.thread({ agent: "concierge", user: "guest-2", threadId: `t${n}` }).status(),
    ).rejects.toMatchObject({ code: "thread.mismatch" });
    expect(() => scope.thread("not a key")).toThrow(expect.objectContaining({ code: "thread.key.invalid" }));
  });

  it("indexes Threads per Agent and User with title and activity", async () => {
    provider.script(["Hi", "Hi", "Hi"]);
    const first = fresh({ user: "indexed" });
    await first.send(message("  Book a   table for two tonight, please  "));
    const second = fresh({ user: "indexed" });
    await second.send(message("Another"));
    await fresh({}).send({ kind: "event", type: "ping", payload: null });

    const mine = await scope.threads.list({ agent: "concierge", user: "indexed" });
    expect(mine.map((t) => t.key)).toEqual([second.key, first.key]);
    expect(mine[1]).toMatchObject({
      agent: "concierge",
      user: "indexed",
      threadId: `t${n - 2}`,
      title: "Book a table for two tonight, please",
    });
    expect(mine[1]!.lastActiveAt).toBeGreaterThanOrEqual(mine[1]!.createdAt);
    expect(mine[0]!.title).toBe("Another");

    const userless = await scope.threads.list({ agent: "concierge", user: null });
    expect(userless.map((t) => t.threadId)).toContain(`t${n}`);
    expect(userless[0]).not.toHaveProperty("user");
    expect(userless[0]).not.toHaveProperty("title");
    expect(await scope.threads.list({ agent: "nobody" })).toEqual([]);
  });
});

describe("Turn failure paths", () => {
  it("rotates to the fallback model at the next Step start after a Provider error", async () => {
    provider.script([[reply.error({ code: "unavailable" })], "Fallback here"]);
    const events = await fresh().send(message("Hi"));
    expect(events).toHaveSequence([
      "step.started",
      "step.started",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    expect(events).toContainEvent({ type: "step.started", n: 1, attempt: 1, model: "anthropic/claude-sonnet-5" });
    expect(events).toContainEvent({ type: "step.started", n: 1, attempt: 2, model: "anthropic/claude-haiku-4-5" });
    expect(events.filter((e) => e.type === "step.completed")).toHaveLength(1);
    expect(lastMessage(events)).toBe("Fallback here");
    expect(provider.requests.map((r) => r.model)).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("fails the Turn once every model has failed", async () => {
    provider.script([[reply.error({ code: "unavailable" })], [reply.error({ code: "rate_limit" })]]);
    const thread = fresh();
    const events = await thread.send(message("Hi"));
    expect(events).toContainEvent({ type: "turn.failed", reason: "provider" });
    expect(await thread.status()).toMatchObject({ state: "idle" });
  });

  it("fails the Turn of an Agent the Scope does not know", async () => {
    const events = await fresh({ agent: "stranger", user: "guest-1" }).send(message("Hi"));
    expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.failed"]);
    expect(events).toContainEvent({ type: "turn.failed", reason: "agent.notFound" });
  });

  it("parks a Turn while the Scope is suspended and resumes it on the next input", async () => {
    provider.script(["Back"]);
    const thread = fresh();
    await scope.suspend();
    try {
      const paused = await thread.send(message("Hi"));
      expect(paused.map((e) => e.type)).toEqual(["turn.started", "turn.paused"]);
      expect(await thread.status()).toMatchObject({ state: "parked", turn: 1 });
    } finally {
      await scope.resume();
    }
    const resumed = await thread.send(message("Again"));
    const all = await thread.events();
    expect(all.map((e) => [e.turn, e.type])).toEqual([
      [1, "turn.started"],
      [1, "turn.paused"],
      [1, "turn.resumed"],
      [1, "step.started"],
      [1, "message.delta"],
      [1, "message.part"],
      [1, "usage.recorded"],
      [1, "step.completed"],
      [1, "turn.completed"],
      [2, "turn.started"],
      [2, "step.started"],
      [2, "step.started"],
      [2, "turn.failed"],
    ]);
    expect(resumed).toContainEvent({ type: "turn.failed", reason: "provider" });
  });
});

describe("queued input", () => {
  it("keeps an input queued while the Scope stays suspended, then runs it once resumed", async () => {
    provider.script(["Back", "Queued"]);
    const thread = fresh();
    await scope.suspend();
    let queued: Promise<ThreadEvent[]>;
    try {
      await thread.send(message("First"));
      queued = thread.send(message("Second"));
      expect((await take(thread.subscribe({ after: 2 }), 2)).map((e) => e.type)).toEqual([
        "turn.resumed",
        "turn.paused",
      ]);
      expect(await thread.status()).toMatchObject({ state: "parked", turn: 1 });
    } finally {
      await scope.resume();
    }
    // The two inputs that waited coalesce into the one next Turn.
    const resumed = await thread.send(message("Third"));
    expect(lastMessage(await queued)).toBe("Queued");
    expect(resumed).toContainEvent({ type: "turn.started", turn: 2, input: message("Second") });
    expect(resumed).toContainEvent({ type: "turn.input", turn: 2, input: message("Third") });
  });

  it("coalesces inputs sent during a Turn into the one next Turn, in order", async () => {
    provider.script(["One", "Two"]);
    const thread = fresh();
    const [first, second, third] = await Promise.all([
      thread.send(message("A")),
      thread.send(message("B")),
      thread.send(message("C")),
    ]);
    expect(first[0]).toMatchObject({ type: "turn.started", turn: 1 });
    expect(second[0]).toMatchObject({ type: "turn.started", turn: 2, input: message("B") });
    expect(second[1]).toMatchObject({ type: "turn.input", turn: 2, input: message("C") });
    expect(third).toEqual(second);
    expect(lastMessage(first)).toBe("One");
    expect(lastMessage(second)).toBe("Two");
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
  });
});
