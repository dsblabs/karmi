import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { bindLogger, consoleLogger, type Logger, type UsageRecord } from "../src/index";
import { reply } from "../src/testing/index";
import { openThreadDatabase } from "../src/db/thread/database";
import { keys } from "../src/keys";
import { UsageOutbox } from "../src/usage";
import { sensitive } from "../src/secrets";
import { clock, karmi, logs, provider, scope, secrets, usage } from "./worker";

// Storage is shared across the file, so each test uses a Thread of its own.
let n = 0;
const fresh = (agent = "concierge") => scope.thread({ agent, user: "guest-1", threadId: `u${++n}` });
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const recorded = (events: { type: string }[]) => events.filter((e): e is UsageRecord => e.type === "usage.recorded");

beforeEach(() => {
  usage.records.length = 0;
  usage.seen.clear();
  usage.failures = 0;
  logs.length = 0;
});

describe("usage.recorded", () => {
  it("logs a model record with the attribution tuple before the Step ends and totals it in status()", async () => {
    provider.script([[reply.text("Hi"), reply.usage({ input: 120, output: 7, cacheRead: 30, reasoning: 2 })]]);
    const thread = fresh();
    const events = await thread.send(message("Hello"));
    expect(events).toHaveSequence(["step.started", "usage.recorded", "step.completed", "turn.completed"]);
    const [record] = recorded(events);
    expect(record).toMatchObject({
      kind: "model",
      scope: "test",
      agent: "concierge",
      user: "guest-1",
      threadId: `u${n}`,
      turn: 1,
      model: "claude-sonnet-5",
      provider: "fake",
      profile: "default",
      input: 120,
      output: 7,
      cacheRead: 30,
      cacheWrite: 0,
      reasoning: 2,
    });
    expect(record).not.toHaveProperty("cost");
    expect(record).not.toHaveProperty("gateway");
    expect(record).not.toHaveProperty("parent");
    expect((await thread.status()).usage).toEqual({
      input: 120,
      output: 7,
      cacheRead: 30,
      cacheWrite: 0,
      reasoning: 2,
    });
  });

  it("carries a reported cost and a gateway log id through unchanged, and never prices tokens itself", async () => {
    provider.script([
      [
        reply.text("Priced"),
        reply.usage({
          input: 10,
          output: 1,
          serverToolCalls: 1,
          cost: { amount: 0.0042, currency: "USD", source: "openrouter", basis: "billed", upstream: 0.004 },
        }),
      ],
      [reply.text("Gated"), reply.usage({ input: 10, output: 1, gateway: { provider: "cloudflare", id: "log-1" } })],
    ]);
    const thread = fresh();
    const [priced] = recorded(await thread.send(message("one")));
    expect(priced).toMatchObject({
      serverToolCalls: 1,
      cost: { amount: 0.0042, currency: "USD", source: "openrouter", basis: "billed", upstream: 0.004 },
    });
    const [gated] = recorded(await thread.send(message("two")));
    expect(gated).toMatchObject({ gateway: { provider: "cloudflare", id: "log-1" } });
    expect(gated).not.toHaveProperty("cost");
  });

  it("records the credential source and version of the call", async () => {
    const id = "usage-byok";
    const tenant = karmi.scope(id);
    await tenant.config.set({
      providers: { own: { adapter: "fake", models: ["*"], credential: "scope:anthropic" } },
    });
    await secrets.put({ scope: id, ref: "scope:anthropic" }, sensitive("tenant-key"));
    provider.script(["Own key"]);
    const thread = tenant.thread({ agent: "byok", user: "u", threadId: "own" });
    await thread.send(message("go"));
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    const [record] = recorded(await thread.events());
    expect(record).toMatchObject({ profile: "own", credentialSource: "scope", credentialVersion: 1 });
    expect(record).not.toHaveProperty("fallback");
    expect(JSON.stringify(record)).not.toContain("tenant-key");
  });

  it("records a compact Step's summarising call as kind compaction", async () => {
    provider.script([
      [reply.text("one"), reply.usage({ input: 950, output: 1 })],
      [reply.text("SUMMARY"), reply.usage({ input: 300, output: 5 })],
      "two",
    ]);
    const thread = fresh("compactor");
    const big = (label: string) => `${label} ${"x".repeat(600)}`;
    await thread.send(message(big("one")));
    const events = await thread.send(message(big("two")));
    expect(events).toHaveSequence(["thread.compacted", "usage.recorded", "step.completed"]);
    expect(events).toContainEvent({
      type: "usage.recorded",
      kind: "compaction",
      model: "claude-sonnet-5",
      provider: "fake",
      input: 300,
      output: 5,
    });
    expect(recorded(events).map((r) => r.kind)).toEqual(["compaction", "model"]);
  });

  it("delivers records to the UsageHandler through the Queue with threadId:seq as the idempotency key", async () => {
    provider.script([[reply.text("Metered"), reply.usage({ input: 5, output: 1 })]]);
    const thread = fresh();
    const events = await thread.send(message("meter me"));
    const [record] = recorded(events);
    // The Test kit's clock fires every due alarm, so earlier Threads of this file flush as well.
    const mine = () => usage.records.filter((r) => r.threadId === record!.threadId);
    await clock.advance(0);
    await expect.poll(() => mine().length).toBe(1);
    expect(mine()[0]).toEqual(record);
    expect(usage.seen.has(`${record!.threadId}:${record!.seq}`)).toBe(true);
  });

  it("retries a failed batch and lets the handler drop a duplicate delivery", async () => {
    const records: UsageRecord[] = [
      {
        type: "usage.recorded",
        seq: 5,
        turn: 1,
        at: clock.now(),
        kind: "model",
        scope: "test",
        agent: "concierge",
        user: "guest-1",
        threadId: "queue-retry",
        model: "claude-sonnet-5",
        provider: "fake",
        profile: "default",
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ];
    const consume = async () => {
      const body = { kind: "usage", records };
      const batch = createMessageBatch("karmi-test-queue", [{ id: "usage", timestamp: new Date(), body, attempts: 1 }]);
      const ctx = createExecutionContext();
      await karmi.queueHandler(batch, env, ctx);
      return getQueueResult(batch, ctx);
    };
    usage.failures = 1;
    expect(await consume()).toMatchObject({ retryMessages: [{ msgId: "usage" }] });
    expect(usage.records).toEqual([]);
    expect(logs.some((line) => line.level === "warn" && line.message.includes("Queue message failed"))).toBe(true);
    expect(await consume()).toMatchObject({ explicitAcks: ["usage"] });
    expect(await consume()).toMatchObject({ explicitAcks: ["usage"] });
    expect(usage.records).toHaveLength(1);
  });

  it("removes the waiting records of a deleted Thread from the Outbox", async () => {
    provider.script(["Hi"]);
    const thread = fresh();
    await thread.send(message("Hello"));
    const stub = env.KARMI_THREADS.getByName(keys.thread("test", `u${n}`));
    const waiting = () =>
      runInDurableObject(stub, (_, state) => new UsageOutbox(openThreadDatabase(state.storage.sql)).batch(10).seqs);
    // The usage Alarm of the Turn sends its record. The test waits for it, because the Alarm can still be due here.
    await clock.advance(0);
    expect(await waiting()).toEqual([]);
    // This record stands for one that the Queue refused.
    await runInDurableObject(stub, (_, state) => new UsageOutbox(openThreadDatabase(state.storage.sql)).enqueue(1));
    expect(await waiting()).toEqual([1]);
    await thread.delete();
    await clock.advance("1m");
    expect(await waiting()).toEqual([]);
  });

  it("lets a Delegation child record its own spend with parent set, never counted on the parent", async () => {
    await scope.agents.put({
      agentId: "usage-delegator",
      name: "Delegator",
      instructions: [],
      model: { id: "shared/parent" },
      delegates: ["concierge"],
      capabilities: { delegation: {} },
    });
    provider.script(({ request }) =>
      request.model === "parent"
        ? request.messages.some((m) => m.role === "toolResult")
          ? [reply.text("Parent done"), reply.usage({ input: 20, output: 2 })]
          : [
              reply.toolCall("delegate", { agent: "concierge", task: "Child task" }, "child-call"),
              reply.usage({ input: 10, output: 1 }),
            ]
        : [reply.text("Child done"), reply.usage({ input: 100, output: 10 })],
    );
    const thread = scope.thread({ agent: "usage-delegator", user: "guest-1", threadId: "usage-parent" });
    await thread.send(message("Delegate"));
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    const parentRecords = recorded(await thread.events());
    expect(parentRecords.map((r) => r.kind === "model" && r.input)).toEqual([10, 20]);
    expect((await thread.status()).usage).toMatchObject({ input: 30, output: 3 });
    const started = (await thread.events()).find((e) => e.type === "delegation.started");
    if (started?.type !== "delegation.started") throw new Error("No delegation.started");
    const child = scope.thread(started.childKey);
    const [childRecord] = recorded(await child.events());
    expect(childRecord).toMatchObject({
      kind: "model",
      input: 100,
      agent: "concierge",
      parent: { threadKey: thread.key, callId: expect.stringContaining("usage-parent:") },
    });
    expect((await child.status()).usage).toMatchObject({ input: 100, output: 10 });
  });
});

describe("Logger", () => {
  it("stamps ctx.logger lines with the Thread's attribution and redacts credential-named fields", async () => {
    provider.script([[reply.toolCall("weather", { city: "Oslo" }, "w1")], "Done"]);
    const thread = fresh();
    await thread.send(message("weather?"));
    const line = logs.find((entry) => entry.message === "weather called");
    expect(line?.fields).toEqual({
      scope: "test",
      agent: "concierge",
      user: "guest-1",
      thread: `u${n}`,
      turn: 1,
      city: "Oslo",
      apiKey: "[REDACTED]",
    });
  });

  it("redacts credentials by value, by field name and inside bearer strings before the Logger sees them", () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const sink: Logger = {
      debug: () => undefined,
      info: (message, fields) => lines.push({ message, ...(fields && { fields }) }),
      warn: () => undefined,
      error: () => undefined,
    };
    bindLogger(sink, { scope: "s" }).info("hello", {
      key: sensitive("sk"),
      apiKey: "plain",
      nested: { authorization: "Bearer abc", note: "Authorization: Bearer abc.def-ghi rest" },
      list: ["Basic dXNlcjpwYXNz", { password: "p" }],
      count: 3,
      when: null,
    });
    expect(lines).toEqual([
      {
        message: "hello",
        fields: {
          scope: "s",
          key: "[SensitiveValue]",
          apiKey: "[REDACTED]",
          nested: { authorization: "[REDACTED]", note: "Authorization: Bearer [REDACTED] rest" },
          list: ["Basic [REDACTED]", { password: "[REDACTED]" }],
          count: 3,
          when: null,
        },
      },
    ]);
  });

  it("writes one JSON line per call on the console by default", () => {
    const written: string[] = [];
    const original = console.info;
    console.info = (line: string) => void written.push(line);
    try {
      consoleLogger().info("hello", { scope: "s" });
    } finally {
      console.info = original;
    }
    expect(written).toEqual([JSON.stringify({ level: "info", message: "hello", scope: "s" })]);
  });
});
