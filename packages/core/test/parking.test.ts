import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpec, ThreadEvent } from "../src/index";
import { lastMessage, reply } from "../src/testing/index";
import { clock, gate, karmi, provider, scope, trace, untilOpen } from "./worker";

// Storage is shared across the file, so each test uses a Thread of its own; every Thread is cancelled
// afterwards so a park left behind cannot wake on a later test's clock and eat its scripted replies.
let n = 0;
const opened: ReturnType<typeof scope.thread>[] = [];
const fresh = (agent = "approver") => {
  const thread = scope.thread({ agent, user: "guest-1", threadId: `park-${++n}` });
  opened.push(thread);
  return thread;
};
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const STEP_WATCHDOG_MS = 60_000;
const requestSeq = (events: ThreadEvent[]) => events.find((e) => e.type === "approval.requested")!.seq;
/** Everything the Turn logs after the events seen so far, up to its end or next park. */
async function rest(thread: ReturnType<typeof fresh>, seen: ThreadEvent[]): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: seen.at(-1)!.seq })) {
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
  }
  return events;
}

beforeEach(() => {
  trace.length = 0;
  gate.open = false;
});

afterEach(async () => {
  // A cancel that lands during a park's Hooks completes once they return; wait so nothing bleeds into the next test.
  for (const thread of opened.splice(0)) {
    await thread.cancel();
    await expect.poll(async () => (await thread.status()).state).toBe("idle");
  }
});

describe("tool Approvals", () => {
  it("runs the allowed calls of the batch, then parks one request per asked call until it is answered", async () => {
    provider.script([
      [reply.toolCall("lookup", { id: "a" }, "c1"), reply.toolCall("book", { room: 7 }, "c2")],
      "Booked",
    ]);
    const thread = fresh();
    const parked = await thread.send(message("Book 7"));
    expect(parked).toHaveSequence([
      "step.started",
      "step.completed",
      "step.started",
      "tool.call",
      "tool.result",
      "approval.requested",
      "turn.paused",
    ]);
    expect(parked).toContainEvent({ type: "tool.result", id: "c1", content: [{ type: "text", text: "Guest a" }] });
    expect(parked).toContainEvent({
      type: "approval.requested",
      kind: "tool",
      id: "c2",
      tool: "book",
      input: { room: 7 },
    });
    expect(parked).toContainEvent({ type: "turn.paused", reason: "approval" });
    const request = parked.find((e) => e.type === "approval.requested")!;
    expect(request.type === "approval.requested" && request.timeoutAt - request.at).toBe(60 * 60 * 1000);
    expect(await thread.status()).toMatchObject({
      state: "parked",
      turn: 1,
      step: 2,
      paused: "approval",
      pendingApprovals: [{ seq: request.seq, kind: "tool", tool: "book", timeoutAt: request.timeoutAt }],
    });
    await expect
      .poll(() => trace.filter((entry) => entry.startsWith("after-turn")))
      .toEqual(["after-turn:1:turn.paused"]);

    await thread.approve(request.seq, { decision: "allow", by: "alice" });
    const resumed = await rest(thread, parked);
    expect(resumed).toHaveSequence([
      "approval.resolved",
      "turn.resumed",
      "tool.call",
      "tool.result",
      "step.completed",
      "step.started",
      "step.completed",
      "turn.completed",
    ]);
    expect(resumed).toContainEvent({
      type: "approval.resolved",
      request: request.seq,
      kind: "tool",
      decision: "allow",
      by: "alice",
      source: "answer",
    });
    expect(resumed).toContainEvent({ type: "turn.resumed", reason: "approval" });
    expect(resumed).toContainEvent({
      type: "tool.result",
      id: "c2",
      name: "book",
      content: [{ type: "text", text: "Booked 7" }],
      isError: false,
    });
    expect(lastMessage(resumed)).toBe("Booked");
    expect(
      provider.requests[1]?.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.role === "toolResult" && m.toolCallId),
    ).toEqual(["c1", "c2"]);
    expect(await thread.status()).toMatchObject({ state: "idle" });

    await expect(thread.approve(request.seq, { decision: "deny" })).rejects.toMatchObject({
      code: "approval.resolved",
    });
    await expect(thread.approve(999, { decision: "deny" })).rejects.toMatchObject({ code: "approval.notFound" });
  });

  it("answers a denied call with an isError result the model sees next, and never remembers a deny", async () => {
    provider.script([
      [reply.toolCall("book", { room: 1 }, "c1")],
      "Sorry",
      [reply.toolCall("book", { room: 2 }, "c2")],
      "Again",
    ]);
    const thread = fresh();
    const parked = await thread.send(message("Book"));
    await thread.approve(requestSeq(parked), { decision: "deny", reason: "Not today", remember: true });
    const resumed = await rest(thread, parked);
    expect(resumed).toContainEvent({
      type: "approval.resolved",
      decision: "deny",
      reason: "Not today",
      source: "answer",
    });
    expect(resumed).toContainEvent({
      type: "tool.result",
      id: "c1",
      name: "book",
      isError: true,
      content: [{ type: "text", text: 'Tool "book" was denied: Not today' }],
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      isError: true,
    });
    await expect
      .poll(() => trace.filter((entry) => entry.startsWith("after-turn")))
      .toEqual(["after-turn:1:turn.paused", "after-turn:1:turn.completed"]);

    const second = await thread.send(message("Book again"));
    expect(second).toContainEvent({ type: "turn.paused", reason: "approval" });
  });

  it("remembers an allow by Tool name for the rest of the Thread", async () => {
    provider.script([
      [reply.toolCall("book", { room: 1 }, "c1")],
      "Done",
      [reply.toolCall("book", { room: 2 }, "c2")],
      "Done again",
    ]);
    const thread = fresh();
    const parked = await thread.send(message("Book"));
    await thread.approve(requestSeq(parked), { decision: "allow", remember: true });
    await rest(thread, parked);
    const second = await thread.send(message("Book again"));
    expect(second.map((e) => e.type)).not.toContain("approval.requested");
    expect(second).toContainEvent({ type: "tool.result", id: "c2", content: [{ type: "text", text: "Booked 2" }] });
    expect(lastMessage(second)).toBe("Done again");
  });

  it("times out to a deny on the clock, at the Spec's timeout under the Scope ceiling", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "Timed out"]);
    const thread = fresh();
    const parked = await thread.send(message("Book"));
    await clock.advance("59m");
    expect((await thread.events()).filter((e) => e.type === "approval.resolved")).toHaveLength(0);
    await clock.advance("1m");
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    const events = await thread.events();
    expect(events).toContainEvent({
      type: "approval.resolved",
      request: requestSeq(parked),
      decision: "deny",
      source: "timeout",
    });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: true,
      content: [{ type: "text", text: 'Tool "book" was denied: the approval timed out.' }],
    });
    expect(lastMessage(events)).toBe("Timed out");

    // A Scope ceiling below the Spec's timeout wins.
    const { revision } = await scope.config.set({ ceilings: { approvals: { timeout: 60_000 } } });
    try {
      provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "Ceiling"]);
      const capped = fresh();
      const request = (await capped.send(message("Book"))).find((e) => e.type === "approval.requested")!;
      expect(request.type === "approval.requested" && request.timeoutAt - request.at).toBe(60_000);
    } finally {
      await scope.config.set({}, { ifRevision: revision });
    }
  });

  it("continues at once on an answer that lands while the park's after-turn Hooks still run", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "Quick"]);
    const thread = fresh();
    const parked = await thread.send(message("Book"));
    // The test-kit `send` resolves on the `turn.paused` append, before the slow Hook returns.
    await thread.approve(requestSeq(parked), { decision: "allow" });
    const resumed = await rest(thread, parked);
    expect(resumed.filter((e) => e.type === "turn.resumed")).toEqual([expect.objectContaining({ reason: "approval" })]);
    expect(lastMessage(resumed)).toBe("Quick");
    expect(resumed.at(-1)!.at - parked.at(-1)!.at).toBeLessThan(STEP_WATCHDOG_MS);
  });

  it("parks until every asked call of the batch is answered", async () => {
    provider.script([
      [reply.toolCall("book", { room: 1 }, "c1"), reply.toolCall("weather", { city: "Rome" }, "c2")],
      "Both",
    ]);
    const thread = fresh();
    const parked = await thread.send(message("Two"));
    const requests = parked.filter((e) => e.type === "approval.requested");
    expect(requests.map((e) => e.type === "approval.requested" && e.kind === "tool" && e.tool)).toEqual([
      "book",
      "weather",
    ]);
    await thread.approve(requests[0]!.seq, { decision: "allow" });
    expect(await thread.status()).toMatchObject({ state: "parked", pendingApprovals: [{ seq: requests[1]!.seq }] });
    await thread.approve(requests[1]!.seq, { decision: "deny" });
    const resumed = await rest(thread, parked);
    expect(resumed).toContainEvent({ type: "tool.result", id: "c1", isError: false });
    expect(resumed).toContainEvent({ type: "tool.result", id: "c2", isError: true });
    expect(resumed.filter((e) => e.type === "turn.resumed")).toHaveLength(1);
    expect(lastMessage(resumed)).toBe("Both");
  });
});

describe("longRunning budget", () => {
  const loop = () =>
    provider.script(({ index }) =>
      index < 5
        ? [reply.toolCall("lookup", { id: String(index) }, `c${index}`), reply.usage({ input: 10, output: 5 })]
        : "Finished",
    );

  it("parks for a continue Approval when the Step budget is spent and continues on allow with a fresh window", async () => {
    loop();
    const thread = fresh("budgeted");
    const parked = await thread.send(message("Loop"));
    expect(parked.filter((e) => e.type === "step.completed")).toHaveLength(3);
    expect(parked).toContainEvent({ type: "approval.requested", kind: "continue", budget: { steps: 3, tokens: 30 } });
    expect(parked).toContainEvent({ type: "turn.paused", reason: "budget" });
    expect(await thread.status()).toMatchObject({
      state: "parked",
      paused: "budget",
      budget: { steps: 3, tokens: 30, max: { steps: 3, tokens: 100 } },
    });

    await thread.approve(requestSeq(parked), { decision: "allow" });
    const resumed = await rest(thread, parked);
    expect(resumed).toContainEvent({ type: "turn.resumed", reason: "approval" });
    expect(resumed).toContainEvent({ type: "step.started", n: 4 });
    expect(resumed).toContainEvent({ type: "approval.requested", kind: "continue", budget: { steps: 3 } });
    expect(resumed).toContainEvent({ type: "turn.paused", reason: "budget" });
  });

  it("ends the Turn with stopReason budget when the continue is denied or times out", async () => {
    loop();
    const denied = fresh("budgeted");
    const parked = await denied.send(message("Loop"));
    await denied.approve(requestSeq(parked), { decision: "deny" });
    const ended = await rest(denied, parked);
    expect(ended.map((e) => e.type)).toEqual(["approval.resolved", "turn.completed"]);
    expect(ended).toContainEvent({ type: "turn.completed", stopReason: "budget" });
    expect(await denied.status()).toMatchObject({ state: "idle" });

    loop();
    const expired = fresh("budgeted");
    await expired.send(message("Loop"));
    await clock.advance("24h");
    await expect.poll(async () => (await expired.events()).some((e) => e.type === "turn.completed")).toBe(true);
    expect(await expired.events()).toContainEvent({
      type: "approval.resolved",
      kind: "continue",
      decision: "deny",
      source: "timeout",
    });
    expect(await expired.events()).toContainEvent({ type: "turn.completed", stopReason: "budget" });
  });

  it("counts tokens against the budget", async () => {
    provider.script(({ index }) =>
      index < 5
        ? [reply.toolCall("lookup", { id: String(index) }, `c${index}`), reply.usage({ input: 50, output: 10 })]
        : "Finished",
    );
    const parked = await fresh("budgeted").send(message("Loop"));
    expect(parked).toContainEvent({ type: "approval.requested", kind: "continue", budget: { steps: 3, tokens: 120 } });
  });

  it("bounds an Agent without the grant to the small defaults", async () => {
    provider.script(({ index }) =>
      index < 20 ? [reply.toolCall("lookup", { id: String(index) }, `c${index}`)] : "Finished",
    );
    const parked = await fresh("concierge").send(message("Loop"));
    expect(parked).toContainEvent({ type: "approval.requested", kind: "continue", budget: { steps: 25 } });
  });
});

describe("Job seam", () => {
  it("parks the tool Step on a pending Job and resumes it when the Job completes", async () => {
    provider.script([[reply.toolCall("start_job", { job: "ingest-1" }, "c1")], "Ingested"]);
    const thread = fresh();
    const parked = await thread.send(message("Ingest"));
    expect(parked).toHaveSequence(["tool.call", "job.started", "turn.paused"]);
    expect(parked).toContainEvent({ type: "job.started", id: "c1", jobId: "ingest-1" });
    expect(parked).toContainEvent({ type: "turn.paused", reason: "job" });
    expect(await thread.status()).toMatchObject({ state: "parked", paused: "job" });

    await thread.jobs.progress("ingest-1", "half way");
    expect(await thread.status()).toMatchObject({ state: "parked" });
    await thread.jobs.complete("ingest-1", { content: [{ type: "text", text: "12 documents" }] });
    const resumed = await rest(thread, parked);
    expect(resumed).toHaveSequence([
      "job.progress",
      "job.completed",
      "turn.resumed",
      "tool.result",
      "step.completed",
      "step.started",
      "step.completed",
      "turn.completed",
    ]);
    expect(resumed).toContainEvent({
      type: "job.progress",
      jobId: "ingest-1",
      content: [{ type: "text", text: "half way" }],
    });
    expect(resumed).toContainEvent({ type: "turn.resumed", reason: "job" });
    expect(resumed).toContainEvent({
      type: "tool.result",
      id: "c1",
      name: "start_job",
      content: [{ type: "text", text: "12 documents" }],
      isError: false,
    });
    expect(lastMessage(resumed)).toBe("Ingested");
    await expect(thread.jobs.complete("ingest-1", { content: [] })).rejects.toMatchObject({ code: "job.notFound" });
  });

  it("turns a failed or cancelled Job into an isError result", async () => {
    provider.script([
      [reply.toolCall("start_job", { job: "j1" }, "c1"), reply.toolCall("start_job", { job: "j2" }, "c2")],
      "Both back",
    ]);
    const thread = fresh();
    const parked = await thread.send(message("Two jobs"));
    await thread.jobs.fail("j1", "disk full");
    expect(await thread.status()).toMatchObject({ state: "parked" });
    await thread.jobs.cancel("j2");
    const resumed = await rest(thread, parked);
    expect(resumed).toContainEvent({ type: "job.failed", jobId: "j1", message: "disk full" });
    expect(resumed).toContainEvent({ type: "job.cancelled", jobId: "j2" });
    expect(resumed).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: true,
      content: [{ type: "text", text: "Job failed: disk full" }],
    });
    expect(resumed).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: true,
      content: [{ type: "text", text: "Job cancelled." }],
    });
    expect(lastMessage(resumed)).toBe("Both back");
  });
});

describe("cancel, steer and coalescing", () => {
  it("cancels a parked Turn, denies its pending asks with source cancel, and still runs the queued inputs", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "Next"]);
    const thread = fresh();
    const parked = await thread.send(message("Book"));
    const queued = thread.send(message("After"));
    await thread.cancel();
    // A cancel that lands while the park's Hooks still run is carried out as soon as they return.
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.failed")).toBe(true);
    const events = await thread.events();
    expect(
      events
        .filter((e) => e.turn === 1)
        .slice(parked.length)
        .map((e) => e.type),
    ).toEqual(["approval.resolved", "turn.failed"]);
    expect(events).toContainEvent({
      type: "approval.resolved",
      request: requestSeq(parked),
      decision: "deny",
      source: "cancel",
    });
    expect(events).toContainEvent({ type: "turn.failed", turn: 1, reason: "cancelled" });
    expect(lastMessage(await queued)).toBe("Next");
    await expect
      .poll(() => trace.filter((entry) => entry.startsWith("after-turn")))
      .toEqual(["after-turn:1:turn.paused", "after-turn:1:turn.failed:aborted", "after-turn:2:turn.completed"]);
  });

  it("cancels a running Turn promptly even while the model call hangs", async () => {
    provider.script(({ index }) => (index === 0 ? new Promise<string>(() => {}) : "Fine"));
    const thread = karmi.scope("test").thread({ agent: "approver", user: "guest-1", threadId: "park-cancel-running" });
    await thread.send(message("Hang"));
    await expect.poll(() => provider.requests.length).toBe(1);
    await thread.cancel();
    expect(await thread.events()).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    expect(await thread.status()).toMatchObject({ state: "idle" });
    await thread.cancel();
    expect(lastMessage(await scope.thread(thread.key).send(message("Again")))).toBe("Fine");
  });

  it("injects a steer input at the next batch boundary of the running Turn", async () => {
    provider.script([[reply.toolCall("wait_gate", {}, "c1")], "Steered"]);
    const raw = karmi.scope("test").thread({ agent: "approver", user: "guest-1", threadId: "park-steer" });
    const thread = scope.thread(raw.key);
    const started = await raw.send(message("Start"));
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "tool.call")).toBe(true);
    const steered = await raw.send(message("Actually, stop"), { steer: true });
    expect(steered.turn).toBe(started.turn);
    gate.open = true;
    const events = await rest(thread, [{ seq: started.seq } as ThreadEvent]);
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "step.started",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "step.started",
      "tool.call",
      "tool.result",
      "step.completed",
      "turn.input",
      "step.started",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ]);
    expect(events).toContainEvent({ type: "turn.input", steer: true, input: message("Actually, stop") });
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "Actually, stop" }],
    });
  });

  it("runs a steer that arrives during the last model Step as one more model Step", async () => {
    provider.script(async ({ index }) => {
      if (index === 0) await untilOpen();
      return index === 0 ? "Ok" : "Steered late";
    });
    const identity = { agent: "approver", user: "guest-1", threadId: `park-${++n}` };
    const raw = karmi.scope("test").thread(identity);
    const thread = scope.thread(identity);
    const { seq } = await raw.send(message("Hi"));
    await expect.poll(() => provider.requests.length).toBe(1);
    const steered = await raw.send(message("Also this"), { steer: true });
    expect(steered.turn).toBe(1);
    gate.open = true;
    const events = await rest(thread, [{ seq } as ThreadEvent]);
    expect(events.filter((e) => e.type === "step.started" && e.kind === "model").map((e) => e.n)).toEqual([1, 2]);
    expect(lastMessage(events)).toBe("Steered late");
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("coalesces inputs sent during a Turn into one next Turn, in order", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "One", "Two"]);
    const thread = fresh();
    const parked = await thread.send(message("A"));
    const [b, c] = [thread.send(message("B")), thread.send(message("C"))];
    expect(await thread.status()).toMatchObject({ state: "parked" });
    await thread.approve(requestSeq(parked), { decision: "allow" });
    const second = await b;
    expect(await c).toEqual(second);
    expect(second[0]).toMatchObject({ type: "turn.started", turn: 2, input: message("B") });
    expect(second[1]).toMatchObject({ type: "turn.input", turn: 2, input: message("C") });
    expect(lastMessage(second)).toBe("Two");
    expect(provider.requests[2]?.messages.slice(-2)).toEqual([
      { role: "user", content: [{ type: "text", text: "B" }] },
      { role: "user", content: [{ type: "text", text: "C" }] },
    ]);
  });
});

describe("Scope suspension", () => {
  it("parks at the next Step boundary and continues on thread.resume() under a fresh snapshot", async () => {
    provider.script([[reply.toolCall("wait_gate", {}, "c1")], "Back"]);
    const identity = { agent: "approver", user: "guest-1", threadId: `park-${++n}` };
    const thread = scope.thread(identity);
    try {
      const raw = karmi.scope("test").thread(identity);
      const { seq } = await raw.send(message("Suspend"));
      await expect.poll(async () => (await thread.events()).some((e) => e.type === "tool.call")).toBe(true);
      await scope.suspend();
      gate.open = true;
      const parked = await rest(thread, [{ seq } as ThreadEvent]);
      expect(parked).toHaveSequence(["tool.result", "step.completed", "turn.paused"]);
      expect(parked).toContainEvent({ type: "turn.paused", reason: "scope_suspended" });
      await expect(thread.resume()).rejects.toMatchObject({ code: "scope.suspended" });
      const spec = (await scope.agents.get("approver")).spec as AgentSpec;
      await scope.agents.put({ ...spec, name: "Approver v2" });
    } finally {
      await scope.resume();
    }
    const before = await thread.events();
    await thread.resume();
    const resumed = await rest(thread, before);
    expect(resumed).toContainEvent({ type: "turn.resumed", reason: "resume" });
    expect(resumed).toContainEvent({ type: "step.started", kind: "model", n: 3, agentVersion: 2 });
    expect(lastMessage(resumed)).toBe("Back");
    await expect(thread.resume()).rejects.toMatchObject({ code: "thread.notParked" });
  });
});
