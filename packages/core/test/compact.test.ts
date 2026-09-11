import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { KarmiBindings } from "../src/bindings.js";
import { SUMMARY_SYSTEM } from "../src/compaction.js";
import { keys } from "../src/keys.js";
import type { Message, ProviderEvent, Thread, ThreadEvent } from "../src/index.js";
import { lastMessage, reply, type Reply } from "../src/testing/index.js";
import { clock, karmi, provider, scope, trace } from "./worker.js";

// Storage is shared across the file, so each test uses a Thread of its own. The `compactor` Agent's
// window is 1000 tokens with 100 reserved and 100 kept, so a usage of 950 puts the next Step over.
let n = 0;
const fresh = (agent = "compactor") => scope.thread({ agent, user: "guest-1", threadId: `c${++n}` });
/** About 150 tokens: enough that the latest Turn alone covers `keepRecentTokens`. */
const big = (label: string) => `${label} ${"x".repeat(600)}`;
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "claude-sonnet-5",
  stopReason: "end_turn",
});
const summaryOf = (summary: string) => user(`Summary of the conversation so far:\n\n${summary}`);
const ASK = user("Summarise the conversation above.");
const seqOf = (events: ThreadEvent[], type: ThreadEvent["type"]) => events.find((e) => e.type === type)?.seq;

describe("automatic Compaction", () => {
  it("runs a compact Step before the model Step once the last usage puts the context over the limit", async () => {
    provider.script([
      [reply.text("one"), reply.usage({ input: 400, output: 1 })],
      [reply.text("two"), reply.usage({ input: 950, output: 1 })],
      [reply.text("SUMMARY"), reply.usage({ input: 300, output: 5 })],
      "three",
    ]);
    trace.length = 0;
    const thread = fresh();
    await thread.send(message(big("one")));
    await thread.send(message(big("two")));
    const events = await thread.send(message(big("three")));
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "thread.compacted",
      "step.completed",
      "step.started",
      "message.delta",
      "message.part",
      "step.completed",
      "turn.completed",
    ]);
    const firstKeptSeq = seqOf(events, "turn.started")!;
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 1, attempt: 1, trigger: "auto" });
    expect(events).toContainEvent({
      type: "thread.compacted",
      trigger: "auto",
      strategy: "harness",
      firstKeptSeq,
      summary: "SUMMARY",
      provider: "fake",
      model: "claude-sonnet-5",
      attachments: [],
      usage: { input: 300, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    const compacted = events.find((e) => e.type === "thread.compacted");
    expect(compacted?.type === "thread.compacted" && compacted.tokensBefore).toBeGreaterThanOrEqual(951);
    expect(compacted?.type === "thread.compacted" && compacted.tokensAfter).toBeLessThan(400);
    expect(events).toContainEvent({ type: "step.completed", kind: "compact", n: 1 });
    expect(events).toContainEvent({ type: "step.started", kind: "model", n: 2, attempt: 1 });
    expect(lastMessage(events)).toBe("three");
    expect(trace).toEqual(["before-compact:auto:true", `after-compact:harness:${firstKeptSeq}`]);

    // The summarising call sees only what is being dropped; the model Step sees the summary and the kept tail.
    expect(provider.requests[2]).toMatchObject({ system: SUMMARY_SYSTEM });
    expect(provider.requests[2]?.tools).toBeUndefined();
    expect(provider.requests[2]?.messages).toEqual([
      user(big("one")),
      assistant("one"),
      user(big("two")),
      assistant("two"),
      ASK,
    ]);
    expect(provider.requests[3]?.messages).toEqual([summaryOf("SUMMARY"), user(big("three"))]);
    expect((await thread.status()).usage).toEqual({ input: 1650, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  it("chains summaries: the next Compaction summarises the previous summary with the Turns since", async () => {
    provider.script([
      [reply.text("one"), reply.usage({ input: 950 })],
      "FIRST",
      [reply.text("two"), reply.usage({ input: 950 })],
      "SECOND",
      "three",
    ]);
    const thread = fresh();
    await thread.send(message(big("one")));
    await thread.send(message(big("two")));
    const events = await thread.send(message(big("three")));
    expect(events.filter((e) => e.type === "thread.compacted")).toHaveLength(1);
    expect(provider.requests[3]?.messages).toEqual([summaryOf("FIRST"), user(big("two")), assistant("two"), ASK]);
    expect(provider.requests[4]?.messages).toEqual([summaryOf("SECOND"), user(big("three"))]);
    expect(lastMessage(events)).toBe("three");
  });

  it("does not compact when nothing could be dropped: a first Turn still in its tool loop", async () => {
    provider.script([[reply.toolCall("lookup", { id: "g1" }), reply.usage({ input: 950 })], "done"]);
    const thread = fresh();
    const events = await thread.send(message(big("only")));
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "message.delta",
      "message.part",
      "step.completed",
      "step.started",
      "tool.call",
      "tool.result",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "message.delta",
      "message.part",
      "step.completed",
      "turn.completed",
    ]);
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 3, trigger: "auto" });
    expect(events).toContainEvent({ type: "step.completed", kind: "compact", n: 3 });
    expect(events).toContainEvent({ type: "step.started", kind: "model", n: 4 });
    expect(lastMessage(events)).toBe("done");
    expect(provider.requests).toHaveLength(2);
  });

  it("drops the oldest Turn when the tail alone cannot hold keepRecentTokens", async () => {
    provider.script([[reply.text("only"), reply.usage({ input: 950 })], "SUMMARY", "again"]);
    const thread = fresh();
    const first = await thread.send(message(big("only")));
    const events = await thread.send(message("tiny"));
    expect(events).toContainEvent({ type: "thread.compacted", firstKeptSeq: first.at(-1)!.seq + 1 });
    expect(provider.requests[2]?.messages).toEqual([summaryOf("SUMMARY"), user("tiny")]);
  });
});

describe("overflow", () => {
  it("compacts on a context_window_exceeded error and retries the same model", async () => {
    provider.script([
      [reply.text("one"), reply.usage({ input: 100 })],
      [reply.error({ code: "context_window_exceeded" })],
      "SUMMARY",
      "recovered",
    ]);
    const thread = fresh();
    await thread.send(message(big("one")));
    const events = await thread.send(message(big("two")));
    expect(events).toHaveSequence([
      "step.started",
      "step.started",
      "thread.compacted",
      "step.completed",
      "step.started",
      "turn.completed",
    ]);
    expect(events).toContainEvent({ type: "step.started", kind: "model", n: 1, attempt: 1 });
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 2, trigger: "overflow" });
    expect(events).toContainEvent({ type: "thread.compacted", trigger: "overflow", summary: "SUMMARY" });
    expect(events).toContainEvent({ type: "step.started", kind: "model", n: 3, attempt: 1 });
    expect(lastMessage(events)).toBe("recovered");
    expect(provider.requests.map((r) => r.model)).toEqual(Array<string>(4).fill("claude-sonnet-5"));
    expect(provider.requests[3]?.messages).toEqual([summaryOf("SUMMARY"), user(big("two"))]);
  });

  it("lets an overflow with nothing to drop take the ordinary failure path", async () => {
    provider.script([[reply.error({ code: "context_window_exceeded" })]]);
    const events = await fresh().send(message("first"));
    expect(events).toContainEvent({ type: "step.started", kind: "compact", trigger: "overflow" });
    expect(events).not.toContainEvent({ type: "thread.compacted" });
    expect(events).toContainEvent({ type: "turn.failed", reason: "provider" });
    expect(provider.requests).toHaveLength(1);
  });
});

describe("thread.compact()", () => {
  it("compacts an idle Thread on request, passing instructions to the Hooks and the summariser", async () => {
    provider.script([
      [reply.text("one"), reply.usage({ input: 100 })],
      [reply.text("two"), reply.usage({ input: 200 })],
      "SUMMARY",
      "three",
    ]);
    trace.length = 0;
    const thread = fresh();
    await thread.send(message(big("one")));
    const second = await thread.send(message(big("two")));
    await thread.compact({ instructions: "Keep the names." });
    const events = await thread.events({ after: second.at(-1)!.seq });
    expect(events.map((e) => [e.turn, e.type])).toEqual([
      [2, "step.started"],
      [2, "thread.compacted"],
      [2, "step.completed"],
    ]);
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 2, trigger: "manual" });
    expect(events).toContainEvent({
      type: "thread.compacted",
      trigger: "manual",
      firstKeptSeq: second[0]!.seq,
      summary: "SUMMARY",
    });
    expect(trace).toEqual(["before-compact:manual:true", `after-compact:harness:${second[0]!.seq}`]);
    expect(provider.requests[2]?.messages.at(-1)).toEqual(user("Summarise the conversation above.\n\nKeep the names."));
    const third = await thread.send(message("three"));
    expect(lastMessage(third)).toBe("three");
    expect(provider.requests[3]?.messages).toEqual([
      summaryOf("SUMMARY"),
      user(big("two")),
      assistant("two"),
      user("three"),
    ]);
  });

  it("lets a before-compact Hook skip the Compaction or supply the summary itself", async () => {
    provider.script([[reply.text("one"), reply.usage({ input: 100 })], "two", "three"]);
    const thread = fresh();
    await thread.send(message(big("one")));
    await thread.send(message(big("two")));
    await thread.compact({ instructions: "skip" });
    let events = await thread.events();
    expect(events.filter((e) => e.type === "step.started" && e.kind === "compact")).toHaveLength(1);
    expect(events).not.toContainEvent({ type: "thread.compacted" });

    await thread.compact({ instructions: "hook" });
    events = await thread.events();
    expect(events).toContainEvent({
      type: "thread.compacted",
      strategy: "hook",
      summary: "HOOK SUMMARY",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(provider.requests).toHaveLength(2);
    await thread.send(message("three"));
    expect(provider.requests[2]?.messages).toEqual([
      summaryOf("HOOK SUMMARY"),
      user(big("two")),
      assistant("two"),
      user("three"),
    ]);
  });

  it("is rejected while a Turn is parked, and is a no-op on an empty Thread", async () => {
    await expect(fresh().compact()).resolves.toBeUndefined();
    provider.script([[reply.toolCall("book", { room: 1 })]]);
    const parked = fresh("asking");
    await parked.send(message("Book"));
    expect(await parked.status()).toMatchObject({ state: "parked" });
    await expect(parked.compact()).rejects.toMatchObject({ code: "thread.busy" });
  });
});

describe("provider strategy", () => {
  const compaction: ProviderEvent[] = [
    { type: "message.start", model: "claude-sonnet-5" },
    {
      type: "part",
      index: 0,
      block: {
        type: "compaction",
        summary: "PROVIDER SUMMARY",
        raw: { type: "compaction", content: "PROVIDER SUMMARY", encrypted_content: "ENC" },
      },
    },
    { type: "message.end", stopReason: "end_turn", usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 } },
  ];

  it("asks the provider for its own block and replays it byte-exact in an assistant message", async () => {
    const other = karmi.scope("compact-provider");
    await other.config.set({
      providers: { "provider-compact": { adapter: "fake", models: ["*"], compaction: "provider" } },
    });
    provider.script([[reply.text("one"), reply.usage({ input: 950 })], compaction, "two"]);
    const thread = other.thread({ agent: "compactor-provider", threadId: "p1" });
    await settled(thread, message(big("one")));
    const events = await settled(thread, message(big("two")));
    expect(events).toContainEvent({
      type: "thread.compacted",
      strategy: "provider",
      summary: "PROVIDER SUMMARY",
      raw: { type: "compaction", content: "PROVIDER SUMMARY", encrypted_content: "ENC" },
    });
    expect(provider.requests[1]).toMatchObject({ compact: {}, config: { compaction: "provider" } });
    expect(provider.requests[2]?.messages).toEqual([
      user("The conversation so far was compacted."),
      {
        role: "assistant",
        content: [
          {
            type: "compaction",
            summary: "PROVIDER SUMMARY",
            raw: { type: "compaction", content: "PROVIDER SUMMARY", encrypted_content: "ENC" },
          },
        ],
        provider: "fake",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
      },
      user(big("two")),
    ]);
  });

  it("takes the prose reply as a Harness summary when the provider answers without a block", async () => {
    provider.script([[reply.text("one"), reply.usage({ input: 950 })], "PROSE", "two"]);
    const thread = karmi.scope("compact-provider").thread({ agent: "compactor-provider", threadId: "p2" });
    await settled(thread, message(big("one")));
    const events = await settled(thread, message(big("two")));
    expect(events).toContainEvent({ type: "thread.compacted", strategy: "harness", summary: "PROSE" });
    expect(provider.requests[2]?.messages).toEqual([summaryOf("PROSE"), user(big("two"))]);
  });

  it("ignores a before-compact Hook's summary under the provider strategy", async () => {
    provider.script([[reply.text("one"), reply.usage({ input: 100 })], "two", compaction]);
    const thread = karmi.scope("compact-provider").thread({ agent: "compactor-provider", threadId: "p3" });
    await settled(thread, message(big("one")));
    await settled(thread, message(big("two")));
    await thread.compact({ instructions: "hook" });
    expect(await thread.events()).toContainEvent({ type: "thread.compacted", strategy: "provider" });
  });
});

describe("recovery", () => {
  it("re-runs an evicted compact Step whole and records one Compaction", async () => {
    const replies: Reply[] = [[reply.text("one"), reply.usage({ input: 950 })], "SUMMARY", "two"];
    provider.script(({ index }) => (index === 1 ? new Promise<Reply>(() => {}) : replies[Math.min(index, 2)]!));
    const threadId = "compact-recover";
    const thread = scope.thread({ agent: "compactor", user: "guest-1", threadId });
    await thread.send(message(big("one")));
    const raw = karmi.scope("test").thread({ agent: "compactor", user: "guest-1", threadId });
    await raw.send(message(big("two")));
    await expect.poll(() => provider.requests.length).toBe(2);
    await evictDurableObject((env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", threadId)));
    await clock.advance("1m");
    await expect
      .poll(async () => (await thread.events()).some((e) => e.type === "turn.completed" && e.turn === 2))
      .toBe(true);
    const events = (await thread.events()).filter((e) => e.turn === 2);
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 1, attempt: 1 });
    expect(events).toContainEvent({ type: "turn.resumed", reason: "recovered" });
    expect(events).toContainEvent({ type: "step.started", kind: "compact", n: 1, attempt: 2 });
    expect(events.filter((e) => e.type === "thread.compacted")).toHaveLength(1);
    expect(lastMessage(events)).toBe("two");
  });
});

describe("thread.fork()", () => {
  it("copies the log up to a seq into a new Thread that carries on from there", async () => {
    provider.script(["one", "two", "forked", "three"]);
    const thread = fresh();
    const first = await thread.send(message("one"));
    await thread.send(message("two"));
    const fork = await thread.fork(first.at(-1)!.seq);
    expect(fork.key).not.toBe(thread.key);
    expect((await fork.events()).map((e) => e.seq)).toEqual(first.map((e) => e.seq));
    const forkEvents = await settled(fork, message("branch"));
    expect(forkEvents[0]).toMatchObject({ type: "turn.started", turn: 2 });
    expect(lastMessage(forkEvents)).toBe("forked");
    expect(provider.requests[2]?.messages).toEqual([user("one"), assistant("one"), user("branch")]);
    // The original is untouched.
    const original = await thread.send(message("three"));
    expect(lastMessage(original)).toBe("three");
    expect(provider.requests[3]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("works after a Compaction and refuses a seq past the head or a Thread that exists", async () => {
    provider.script([[reply.text("one"), reply.usage({ input: 950 })], "SUMMARY", "two", "branch"]);
    const thread = fresh();
    await thread.send(message(big("one")));
    const second = await thread.send(message(big("two")));
    const fork = await thread.fork(second.at(-1)!.seq, { threadId: `fork-${n}` });
    const events = await settled(fork, message("branch"));
    expect(lastMessage(events)).toBe("branch");
    expect(provider.requests[3]?.messages).toEqual([
      summaryOf("SUMMARY"),
      user(big("two")),
      assistant("two"),
      user("branch"),
    ]);
    await expect(thread.fork(10_000)).rejects.toMatchObject({ code: "thread.seq.invalid" });
    await expect(thread.fork(1, { threadId: `fork-${n}` })).rejects.toMatchObject({ code: "thread.exists" });
  });
});

/** Sends on a plain Thread and resolves with the Turn's events once it ends or parks. */
async function settled(thread: Thread, input: ReturnType<typeof message>): Promise<ThreadEvent[]> {
  const { turn, seq } = await thread.send(input);
  const events: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: seq })) {
    if (event.turn !== turn) continue;
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
  }
  return events;
}
