import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { ScheduleInput, ThreadEvent } from "../src/index";
import type { ScheduleRequest } from "../src/schedule";
import { reply } from "../src/testing/index";
import { clock, gate, karmi, provider, scope } from "./worker";

// The hand-written `ScheduleInput` (for editor hovers) must stay within what the runtime schema decodes.
expectTypeOf<ScheduleInput>().toMatchTypeOf<ScheduleRequest>();

// Storage is shared across the file, so every test uses a Thread of its own and cancels it afterwards.
let n = 0;
const opened: ReturnType<typeof scope.thread>[] = [];
const fresh = (agent = "concierge", threadId = `schedule-${++n}`) => {
  const thread = scope.thread({ agent, user: "guest-1", threadId });
  opened.push(thread);
  return thread;
};
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const reminder = (n: number) => ({ kind: "event" as const, type: "reminder.due", payload: { n } });
const HOUR = 60 * 60 * 1000;
const eventTurns = (events: ThreadEvent[]) =>
  events.filter((e) => e.type === "turn.started" && e.input.kind === "event");

afterEach(async () => {
  gate.open = true;
  for (const thread of opened.splice(0)) {
    for (const schedule of await thread.schedules()) await thread.cancelSchedule(schedule.scheduleId);
    await thread.cancel();
    await expect.poll(async () => (await thread.status()).state).toBe("idle");
  }
});

describe("thread.schedule", () => {
  it("fires a one-shot as an ordinary Turn input and forgets it", async () => {
    provider.script(() => "Noted");
    const thread = fresh();
    const before = clock.now();
    const { scheduleId, nextAt } = await thread.schedule({ delay: "1h", input: reminder(1) });
    expect(nextAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(nextAt).toBeLessThan(before + HOUR + 5000);
    expect(await thread.events()).toContainEvent({ type: "schedule.created", scheduleId, nextAt, delay: HOUR });
    expect((await thread.status()).nextScheduleAt).toBe(nextAt);
    expect(await thread.schedules()).toEqual([
      { scheduleId, at: nextAt, nextAt, createdAt: expect.any(Number), input: reminder(1) },
    ]);

    await clock.advance("59m");
    expect(eventTurns(await thread.events())).toHaveLength(0);
    await clock.advance("1m");
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    const events = await thread.events();
    expect(events).toHaveSequence(["schedule.created", "schedule.fired", "turn.started", "turn.completed"]);
    expect(events).toContainEvent({ type: "schedule.fired", scheduleId });
    expect(events).toContainEvent({ type: "turn.started", input: reminder(1) });
    expect(await thread.schedules()).toEqual([]);
    expect((await thread.status()).nextScheduleAt).toBeUndefined();
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("reminder.due");
  });

  it("takes `at` as epoch milliseconds or ISO 8601 and `delay` as milliseconds", async () => {
    const thread = fresh();
    const at = clock.now() + 2 * HOUR;
    expect((await thread.schedule({ at, input: reminder(1) })).nextAt).toBe(at);
    expect((await thread.schedule({ at: new Date(at).toISOString(), input: reminder(2) })).nextAt).toBe(at);
    const { nextAt } = await thread.schedule({ delay: 1500, input: reminder(3) });
    expect(nextAt - clock.now()).toBeLessThanOrEqual(1500);
    expect(await thread.schedules()).toHaveLength(3);
  });

  it("rejects anything but exactly one of at, delay or cron, a bad cron, a bad zone or a far horizon", async () => {
    const thread = fresh();
    const invalid = (request: unknown) =>
      expect(thread.schedule(request as never)).rejects.toMatchObject({ code: "schedule.invalid" });
    await invalid({ input: reminder(1) });
    await invalid({ delay: "1h", cron: "* * * * *", input: reminder(1) });
    await invalid({ delay: "soon", input: reminder(1) });
    await invalid({ at: "yesterday", input: reminder(1) });
    await invalid({ cron: "* * * *", input: reminder(1) });
    await invalid({ cron: "0 0 30 2 *", input: reminder(1) });
    await invalid({ cron: "* * * * *", tz: "Mars/Olympus", input: reminder(1) });
    await invalid({ delay: "1h", input: message("not an event") });
    await expect(thread.schedule({ delay: "400d", input: reminder(1) })).rejects.toMatchObject({
      code: "schedule.limit",
    });
    expect(await thread.schedules()).toEqual([]);
  });

  it("caps pending Schedules per Thread", async () => {
    const thread = fresh();
    for (let i = 0; i < 100; i++) await thread.schedule({ delay: "1d", input: reminder(i) });
    await expect(thread.schedule({ delay: "1d", input: reminder(100) })).rejects.toMatchObject({
      code: "schedule.limit",
    });
  });

  it("cancels a Schedule before it fires", async () => {
    const thread = fresh();
    const { scheduleId } = await thread.schedule({ delay: "1h", input: reminder(1) });
    await thread.cancelSchedule(scheduleId);
    expect(await thread.events()).toContainEvent({ type: "schedule.cancelled", scheduleId });
    expect(await thread.schedules()).toEqual([]);
    await expect(thread.cancelSchedule(scheduleId)).rejects.toMatchObject({ code: "schedule.notFound" });
    await clock.advance("2h");
    expect(eventTurns(await thread.events())).toHaveLength(0);
  });

  it("creates a Thread addressed by identity that does not exist yet", async () => {
    provider.script(() => "Created");
    const thread = fresh("concierge", `schedule-new-${Date.now()}`);
    await thread.schedule({ delay: "10m", input: reminder(1) });
    expect(await thread.status()).toMatchObject({ state: "idle", seq: 1 });
    await clock.advance("10m");
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    expect(await scope.threads.list({ agent: "concierge", user: "guest-1" })).toContainEqual(
      expect.objectContaining({ key: thread.key }),
    );
    await expect(scope.thread(thread.key).schedules()).resolves.toEqual([]);
  });

  it("rejects a Schedule on a Thread opened by key that does not exist", async () => {
    const ghost = scope.thread({ agent: "concierge", user: "guest-1", threadId: "schedule-ghost" });
    await expect(scope.thread(ghost.key).schedule({ delay: "1h", input: reminder(1) })).rejects.toMatchObject({
      code: "thread.notFound",
    });
  });

  it("coalesces a firing into the next Turn while the Thread is parked", async () => {
    provider.script(({ request }) =>
      request.messages.some((m) => m.role === "toolResult")
        ? "Booked"
        : JSON.stringify(request.messages).includes("reminder.due")
          ? "Reminded"
          : reply.toolCall("book", { room: 7 }, "c1"),
    );
    const thread = fresh("approver");
    const parked = await thread.send(message("Book 7"));
    expect(parked).toContainEvent({ type: "turn.paused", reason: "approval" });
    const { scheduleId } = await thread.schedule({ delay: "5m", input: reminder(1) });
    await clock.advance("5m");
    expect(await thread.events()).toContainEvent({ type: "schedule.fired", scheduleId });
    expect(await thread.status()).toMatchObject({ state: "parked" });
    expect((await thread.status()).nextScheduleAt).toBeUndefined();
    expect(eventTurns(await thread.events())).toHaveLength(0);
    const request = parked.find((e) => e.type === "approval.requested")!;
    await thread.approve(request.seq, { decision: "allow" });
    await expect.poll(async () => (await thread.events()).filter((e) => e.type === "turn.completed").length).toBe(2);
    const events = await thread.events();
    expect(eventTurns(events)).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.started").at(-1)).toMatchObject({ input: reminder(1) });
  });
});

describe("thread.schedule while a Turn runs", () => {
  it("coalesces a firing into the next Turn while a Turn is running", async () => {
    gate.open = false;
    provider.script(({ request }) =>
      request.messages.some((m) => m.role === "toolResult")
        ? "Released"
        : JSON.stringify(request.messages).includes("reminder.due")
          ? "Reminded"
          : reply.toolCall("wait_gate", {}, "g1"),
    );
    // Registers the Thread for cleanup; the test kit's send() only returns at the Turn's end, and this
    // Turn blocks inside wait_gate, so the raw handle drives it.
    fresh("approver");
    const running = karmi.scope("test").thread({ agent: "approver", user: "guest-1", threadId: `schedule-${n}` });
    await running.send(message("Wait"));
    await running.schedule({ delay: "1m", input: reminder(1) });
    await expect.poll(async () => (await running.status()).state).toBe("running");
    await clock.advance("1m");
    expect(await running.events()).toContainEvent({ type: "schedule.fired" });
    expect(eventTurns(await running.events())).toHaveLength(0);
    gate.open = true;
    await expect.poll(async () => (await running.events()).filter((e) => e.type === "turn.completed").length).toBe(2);
    const events = await running.events();
    expect(eventTurns(events)).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.started").at(-1)).toMatchObject({ input: reminder(1) });
  });
});

describe("cron", () => {
  it("rearms after each firing in the given zone", async () => {
    provider.script(() => "Tick");
    const thread = fresh();
    const { scheduleId, nextAt } = await thread.schedule({
      cron: "0 * * * *",
      tz: "Europe/Berlin",
      input: reminder(1),
    });
    expect(nextAt % HOUR).toBe(0);
    expect(nextAt).toBeGreaterThan(clock.now());
    expect(await thread.schedules()).toEqual([
      { scheduleId, cron: "0 * * * *", tz: "Europe/Berlin", nextAt, createdAt: expect.any(Number), input: reminder(1) },
    ]);
    await clock.advance(nextAt - clock.now());
    await expect.poll(async () => eventTurns(await thread.events()).length).toBe(1);
    expect((await thread.schedules())[0]).toMatchObject({ scheduleId, nextAt: nextAt + HOUR });
    expect(await thread.events()).toContainEvent({ type: "schedule.fired", scheduleId, nextAt: nextAt + HOUR });
    await clock.advance("1h");
    await expect.poll(async () => eventTurns(await thread.events()).length).toBe(2);
    expect((await thread.status()).nextScheduleAt).toBe(nextAt + 2 * HOUR);
  });

  it("defaults the zone to UTC", async () => {
    const thread = fresh();
    const { nextAt } = await thread.schedule({ cron: "0 0 * * *", input: reminder(1) });
    expect(new Date(nextAt).toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect((await thread.schedules())[0]).toMatchObject({ tz: "UTC" });
  });

  it("keeps at most one undelivered firing while the Thread is busy and logs the dropped ticks", async () => {
    provider.script(({ request }) =>
      request.messages.some((m) => m.role === "toolResult")
        ? "Booked"
        : JSON.stringify(request.messages).includes("reminder.due")
          ? "Reminded"
          : reply.toolCall("book", { room: 7 }, "c1"),
    );
    const thread = fresh("approver");
    const parked = await thread.send(message("Book 7"));
    const { scheduleId } = await thread.schedule({ cron: "*/10 * * * *", input: reminder(1) });
    await clock.advance("10m");
    await clock.advance("10m");
    await clock.advance("10m");
    const events = await thread.events();
    expect(events.filter((e) => e.type === "schedule.fired")).toHaveLength(1);
    expect(events.filter((e) => e.type === "schedule.skipped")).toHaveLength(2);
    expect(events).toContainEvent({ type: "schedule.skipped", scheduleId });
    await thread.approve(parked.find((e) => e.type === "approval.requested")!.seq, { decision: "allow" });
    await expect.poll(async () => (await thread.events()).filter((e) => e.type === "turn.completed").length).toBe(2);
    expect(eventTurns(await thread.events())).toHaveLength(1);
    // Delivered now, so the next tick fires again.
    await clock.advance("10m");
    await expect.poll(async () => eventTurns(await thread.events()).length).toBe(2);
  });

  it("does not retry a firing whose Turn failed", async () => {
    provider.script(() => [reply.error({ code: "invalid_request", message: "down" })]);
    const thread = fresh();
    await thread.schedule({ delay: "1m", input: reminder(1) });
    await clock.advance("1m");
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.failed")).toBe(true);
    await clock.advance("1h");
    expect(eventTurns(await thread.events())).toHaveLength(1);
    expect(await thread.schedules()).toEqual([]);
  });
});

describe("scheduling Capability", () => {
  const wakes = (events: ThreadEvent[]) =>
    events.filter((e) => e.type === "turn.started" && e.input.kind === "event" && e.input.type === "schedule.fired");

  it("gives the Agent schedule, list_schedules and cancel_schedule for its own Thread", async () => {
    await scope.agents.put({
      agentId: "planner",
      name: "Planner",
      instructions: [{ text: "Plan." }],
      model: { id: "shared/planner" },
      policy: [{ match: { tool: "*" }, effect: "allow" }],
      capabilities: { scheduling: {} },
    });
    provider.script(({ request }) => {
      const woken = request.messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("schedule.fired"),
      );
      if (woken) return "Woke up";
      const results = request.messages.filter((m) => m.role === "toolResult");
      if (results.length === 0)
        return [
          reply.toolCall("schedule", { delay: "5m", payload: { task: "follow up" } }, "s1"),
          reply.toolCall("schedule", { delay: "1h", payload: { task: "later" } }, "s2"),
        ];
      if (results.length === 2) return reply.toolCall("list_schedules", {}, "l1");
      if (results.length === 3) {
        const block = results[2]?.role === "toolResult" ? results[2].content[0] : undefined;
        const listed: { scheduleId: string; input: { payload: { task: string } } }[] =
          block?.type === "text" ? JSON.parse(block.text) : [];
        const later = listed.find((s) => s.input.payload.task === "later")?.scheduleId;
        return reply.toolCall("cancel_schedule", { scheduleId: later ?? "missing" }, "c1");
      }
      return "Scheduled";
    });
    const thread = fresh("planner");
    const events = await thread.send(message("Remind me"));
    expect(events).toContainEvent({ type: "turn.completed" });
    const created = events.filter((e) => e.type === "schedule.created");
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      delay: 5 * 60 * 1000,
      input: { type: "schedule.fired", payload: { task: "follow up" } },
    });
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: false });
    expect(events).toContainEvent({ type: "schedule.cancelled" });
    expect(await thread.schedules()).toHaveLength(1);
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["schedule", "cancel_schedule", "list_schedules"]),
    );
    await clock.advance("5m");
    await expect.poll(async () => wakes(await thread.events()).length).toBe(1);
    expect(wakes(await thread.events())[0]).toMatchObject({
      input: { kind: "event", type: "schedule.fired", payload: { task: "follow up" } },
    });
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("follow up");
  });

  it("is absent without the grant", async () => {
    provider.script(() => "Plain");
    const thread = fresh();
    await thread.send(message("Hi"));
    expect(provider.requests.at(-1)?.tools?.map((t) => t.name) ?? []).not.toContain("schedule");
  });

  it("enforces maxPending and cron of the grant under the Scope caps", async () => {
    await scope.agents.put({
      agentId: "planner-limited",
      name: "Limited planner",
      instructions: [{ text: "Plan." }],
      model: { id: "shared/planner-limited" },
      policy: [{ match: { tool: "*" }, effect: "allow" }],
      capabilities: { scheduling: { maxPending: 1, cron: false } },
    });
    provider.script(({ request }) =>
      request.messages.some((m) => m.role === "toolResult")
        ? "Done"
        : [
            reply.toolCall("schedule", { cron: "* * * * *", payload: 1 }, "cron"),
            reply.toolCall("schedule", { delay: "1h", payload: 2 }, "one"),
            reply.toolCall("schedule", { delay: "2h", payload: 3 }, "two"),
            reply.toolCall("schedule", { delay: "10d", payload: 3 }, "far"),
          ],
    );
    const thread = fresh("planner-limited");
    const events = await thread.send(message("Plan"));
    expect(events).toContainEvent({
      type: "tool.result",
      id: "cron",
      isError: true,
      content: [{ type: "text", text: "limit_exceeded: cron" }],
    });
    expect(events).toContainEvent({ type: "tool.result", id: "one", isError: false });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "two",
      isError: true,
      content: [{ type: "text", text: "limit_exceeded: maxPending" }],
    });
    expect(await thread.schedules()).toHaveLength(1);
  });

  it("bounds the horizon and lets a Policy ask before the Agent schedules", async () => {
    await scope.agents.put({
      agentId: "planner-asking",
      name: "Asking planner",
      instructions: [{ text: "Plan." }],
      model: { id: "shared/planner-asking" },
      policy: [
        { match: { tool: "schedule" }, effect: "ask" },
        { match: { tool: "*" }, effect: "allow" },
      ],
      capabilities: { scheduling: { maxHorizonMs: HOUR } },
      approvals: { timeout: HOUR },
    });
    provider.script(({ request }) => {
      const results = request.messages.filter((m) => m.role === "toolResult");
      if (results.length === 0) return reply.toolCall("schedule", { delay: "2h", payload: 1 }, "far");
      if (results.length === 1) return reply.toolCall("schedule", { delay: "30m", payload: 2 }, "near");
      return "Done";
    });
    const thread = fresh("planner-asking");
    const first = await thread.send(message("Plan"));
    expect(first).toContainEvent({ type: "approval.requested", kind: "tool", tool: "schedule", id: "far" });
    await thread.approve(first.find((e) => e.type === "approval.requested")!.seq, {
      decision: "allow",
      remember: true,
    });
    await expect.poll(async () => (await thread.status()).state).toBe("idle");
    const events = await thread.events();
    expect(events).toContainEvent({
      type: "tool.result",
      id: "far",
      isError: true,
      content: [{ type: "text", text: "limit_exceeded: maxHorizonMs" }],
    });
    expect(events).toContainEvent({ type: "tool.result", id: "near", isError: false });
    expect(events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
  });
});
