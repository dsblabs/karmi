import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { reply } from "../src/testing/index.js";
import type { KarmiBindings } from "../src/bindings.js";
import { keys } from "../src/keys.js";
import { clock, karmi, provider, recovery, scope } from "./worker.js";

it("recovers an evicted model Step on the clock's watchdog without rotating models", async () => {
  provider.script(({ index }) => (index === 0 ? new Promise<string>(() => {}) : "Recovered"));
  const threadId = "recover-model";
  const thread = scope.thread({ agent: "concierge", threadId });
  await karmi
    .scope("test")
    .thread({ agent: "concierge", threadId })
    .send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  await expect.poll(() => provider.requests.length).toBe(1);
  const bindings = env as KarmiBindings;
  await evictDurableObject(bindings.KARMI_THREADS.getByName(keys.thread("test", threadId)));
  await clock.advance("24h");
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  const events = await thread.events();
  expect(events).toContainEvent({ type: "turn.resumed", reason: "recovered" });
  expect(events).toContainEvent({ type: "step.started", kind: "model", n: 1, attempt: 2 });
  expect(provider.requests.map((r) => r.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5"]);
});

for (const name of ["recover_read", "recover_idempotent", "recover_mutation"]) {
  it(`recovers ${name} without replaying completed calls or before-tool hooks`, async () => {
    const calls: { id: string; callId: string; attempt: number }[] = [];
    recovery.before.length = 0;
    recovery.after.length = 0;
    recovery.execute = async ({ id }, ctx) => {
      calls.push({ id, callId: ctx.callId, attempt: ctx.attempt });
      if (id === "unfinished" && ctx.attempt === 1) return new Promise<string>(() => {});
      return `done:${id}`;
    };
    provider.script([
      [reply.toolCall(name, { id: "finished" }, "a"), reply.toolCall(name, { id: "unfinished" }, "b")],
      "Recovered tools",
    ]);
    const threadId = name;
    const target = { agent: "recovery", threadId };
    const thread = scope.thread(target);
    await karmi
      .scope("test")
      .thread(target)
      .send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
    await expect.poll(async () => (await thread.events()).filter((e) => e.type === "tool.result").length).toBe(1);
    await expect.poll(() => calls.length).toBe(2);
    await evictDurableObject((env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", threadId)));
    await clock.advance("1m");
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    const events = await thread.events();
    expect(events).toContainEvent({ type: "step.started", kind: "tool", n: 2, attempt: 2 });
    expect(events.filter((e) => e.type === "step.started" && e.kind === "model").map((e) => e.n)).toEqual([1, 3]);
    expect(events.filter((e) => e.type === "tool.call")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(2);
    expect(recovery.before).toEqual(["a", "b"]);
    if (name === "recover_mutation") {
      expect(calls).toHaveLength(2);
      expect(events).toContainEvent({
        type: "tool.result",
        id: "b",
        isError: true,
        interrupted: { attempt: 2 },
        content: [
          {
            type: "text",
            text: "This call was interrupted before it reported a result. It may or may not have taken effect; check before repeating it.",
          },
        ],
      });
      expect(recovery.after[1]).toMatchObject({ isError: true, interrupted: { attempt: 2 } });
    } else {
      expect(calls).toEqual([
        { id: "finished", callId: expect.any(String), attempt: 1 },
        { id: "unfinished", callId: calls[1]!.callId, attempt: 1 },
        { id: "unfinished", callId: calls[1]!.callId, attempt: 2 },
      ]);
      expect(recovery.after[1]).toMatchObject({ content: [{ type: "text", text: "done:unfinished" }] });
    }
    expect(provider.requests[1]?.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
  });
}

it("fails after three attempts at one Step and drains the queued input", async () => {
  provider.script(({ index }) => (index < 3 ? new Promise<string>(() => {}) : "Queued"));
  const target = { agent: "concierge", threadId: "exhausted" };
  const thread = karmi.scope("test").thread(target);
  const input = { kind: "message" as const, parts: [{ type: "text" as const, text: "Go" }] };
  await thread.send(input);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect.poll(() => provider.requests.length).toBe(attempt);
    if (attempt === 3) await thread.send(input);
    await evictDurableObject((env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", target.threadId)));
    await clock.advance("1m");
  }
  await expect
    .poll(async () => (await thread.events()).some((e) => e.turn === 2 && e.type === "turn.completed"))
    .toBe(true);
  const events = await thread.events();
  expect(events).toContainEvent({ type: "turn.failed", turn: 1, reason: "recovery" });
  expect(
    events
      .filter((e) => e.turn === 1)
      .filter((e) => e.type === "step.started")
      .map((e) => e.attempt),
  ).toEqual([1, 2, 3]);
  expect(events).toContainEvent({ type: "turn.completed", turn: 2, message: [{ type: "text", text: "Queued" }] });
});

it("keeps a live model call alive and only recovers an evicted Step once its watchdog is due", async () => {
  provider.script(({ index }) => (index === 0 ? new Promise<string>(() => {}) : "Alive"));
  const target = { agent: "concierge", threadId: "keep-alive" };
  const thread = karmi.scope("test").thread(target);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  await expect.poll(() => provider.requests.length).toBe(1);
  await clock.advance("24h");
  expect(provider.requests).toHaveLength(1);
  expect((await thread.events()).filter((e) => e.type === "turn.resumed")).toHaveLength(0);
  await evictDurableObject((env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", target.threadId)));
  await clock.advance("30s");
  expect(provider.requests).toHaveLength(1);
  await clock.advance("30s");
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  const events = await thread.events();
  expect(events.at(-1)!.at - events[0]!.at).toBeGreaterThanOrEqual(86_460_000);
});

it("does not burn a recovery attempt or rotate models for classified platform resets", async () => {
  provider.script(({ index }) => {
    if (index < 4) throw new Error("Durable Object reset because its code was updated.");
    return "After deploy";
  });
  const target = { agent: "concierge", threadId: "platform-reset" };
  const thread = karmi.scope("test").thread(target);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  for (let calls = 1; calls <= 4; calls++) {
    await expect.poll(() => provider.requests.length).toBe(calls);
    await clock.advance("1m");
  }
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  const events = await thread.events();
  expect(events.filter((e) => e.type === "step.started").map((e) => e.attempt)).toEqual([1, 1, 1, 1, 1]);
  expect(provider.requests.map((r) => r.model)).toEqual(Array(5).fill("claude-sonnet-5"));
});

it("resets the recovery budget at each completed Step", async () => {
  provider.script(({ index }) => {
    if (index === 0 || index === 2) return new Promise<string>(() => {});
    return index === 1 ? [reply.toolCall("recover_idempotent", { id: "once" })] : "Done";
  });
  recovery.execute = async (_, ctx) => (ctx.attempt === 1 ? new Promise<string>(() => {}) : "Tool done");
  const target = { agent: "recovery", threadId: "budget-per-step" };
  const thread = karmi.scope("test").thread(target);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  const stub = (env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", target.threadId));
  await expect.poll(() => provider.requests.length).toBe(1);
  await evictDurableObject(stub);
  await clock.advance("1m");
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "tool.call")).toBe(true);
  await evictDurableObject(stub);
  await clock.advance("1m");
  await expect.poll(() => provider.requests.length).toBe(3);
  await evictDurableObject(stub);
  await clock.advance("1m");
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  expect((await thread.events()).filter((e) => e.type === "step.started").map((e) => [e.n, e.attempt])).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [3, 1],
    [3, 2],
  ]);
});

it("bounds a model Step to three attempts even when it first falls back", async () => {
  provider.script(({ index }) =>
    index === 0 ? [reply.error({ code: "unavailable" })] : new Promise<string>(() => {}),
  );
  const target = { agent: "concierge", threadId: "fallback-budget" };
  const thread = karmi.scope("test").thread(target);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Go" }] });
  const stub = (env as KarmiBindings).KARMI_THREADS.getByName(keys.thread("test", target.threadId));
  await expect.poll(() => provider.requests.length).toBe(2);
  await evictDurableObject(stub);
  await clock.advance("1m");
  await expect.poll(() => provider.requests.length).toBe(3);
  await evictDurableObject(stub);
  await clock.advance("1m");
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.failed")).toBe(true);
  expect(provider.requests.map((r) => r.model)).toEqual(["claude-sonnet-5", "claude-haiku-4-5", "claude-haiku-4-5"]);
  expect(await thread.events()).toContainEvent({ type: "turn.failed", reason: "recovery" });
});
