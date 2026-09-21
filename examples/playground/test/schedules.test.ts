import type { ThreadEvent } from "@karmi/core";
import { reply } from "@karmi/core/testing";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SCOPE } from "../src/app";
import { inboxEntrySchema, remindersSchema } from "../src/reminders";
import { api as request, events } from "./client";
import worker, { clock, karmi, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = "/api/scenarios/schedules";

const stateSchema = z.looseObject({
  threadKey: z.string(),
  schedules: z.array(z.looseObject({ scheduleId: z.string(), nextAt: z.number(), cron: z.optional(z.string()) })),
  reminders: remindersSchema,
  inbox: z.array(inboxEntrySchema.extend({ waiting: z.boolean() })),
});

/** Reads the state of the Schedules scenario through its route. */
const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());

/** Creates one Schedule of the operator and returns the new state. */
async function schedule(mode: string, value: string) {
  const created = await api("POST", `${PATH}/schedule`, { mode, value });
  expect(created.status).toBe(200);
  return stateSchema.parse(await created.json());
}

/** Waits until the log of the Thread has this number of events of this type and returns the log. */
async function until(key: string, type: ThreadEvent["type"], count = 1): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).filter((event) => event.type === type).length, { timeout: 10_000 })
    .toBe(count);
  return log;
}

/** Moves the Clock past the wait before an offline delivery, then waits for this number of inbox messages. */
async function delivered(count: number) {
  await clock.advance(1000);
  await expect.poll(async () => (await state()).inbox.length, { timeout: 10_000 }).toBe(count);
  return (await state()).inbox;
}

const remind = [reply.toolCall("send_reminder", { customer: "Sam Rivera", text: "Order A-1042 is ready." }, "r1")];

beforeEach(async () => {
  await api("POST", `${PATH}/reset`);
});

describe("the Schedules of the operator", () => {
  it("creates, lists and cancels a delayed, a timed and a recurring Schedule", async () => {
    await schedule("delay", "1h");
    await schedule("at", new Date(clock.now() + 2 * 60 * 60 * 1000).toISOString());
    const { schedules, threadKey } = await schedule("cron", "0 9 * * *");
    expect(schedules).toHaveLength(3);
    expect(schedules.filter((entry) => entry.cron === "0 9 * * *")).toHaveLength(1);
    // The list has the soonest Schedule first.
    expect(schedules.map((entry) => entry.nextAt)).toEqual(schedules.map((entry) => entry.nextAt).toSorted());

    const cancelled = await api("POST", `${PATH}/schedule/cancel`, { scheduleId: schedules[0]?.scheduleId });
    expect(stateSchema.parse(await cancelled.json()).schedules).toHaveLength(2);
    expect(await events(threadKey)).toContainEvent({ type: "schedule.cancelled" });
  });

  it("answers a timing that is not valid and a Schedule that does not exist with the error of the Framework", async () => {
    const invalid = await api("POST", `${PATH}/schedule`, { mode: "cron", value: "not a cron" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "schedule.invalid" } });
    expect((await api("POST", `${PATH}/schedule`, { mode: "weekly", value: "1" })).status).toBe(400);
    const missing = await api("POST", `${PATH}/schedule/cancel`, { scheduleId: "none" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "schedule.notFound" } });
  });

  it("starts a Turn with the Event of a delayed Schedule when it fires, then deletes the Schedule", async () => {
    provider.script(["The reminder is due."]);
    const { threadKey } = await schedule("delay", "10m");
    await clock.advance("9m");
    expect(await events(threadKey)).not.toContainEvent({ type: "schedule.fired" });
    await clock.advance("1m");
    const log = await until(threadKey, "turn.completed");
    expect(log).toHaveSequence(["schedule.created", "schedule.fired", "turn.started", "turn.completed"]);
    expect(log).toContainEvent({ type: "turn.started", input: { kind: "event", type: "reminder.due" } });
    expect((await state()).schedules).toEqual([]);
  });

  it("fires a recurring Schedule on each tick and keeps it in the list", async () => {
    provider.script(["First tick.", "Second tick."]);
    const { threadKey } = await schedule("cron", "* * * * *");
    await clock.advance("1m");
    await until(threadKey, "turn.completed");
    await clock.advance("1m");
    await until(threadKey, "turn.completed", 2);
    expect((await state()).schedules).toHaveLength(1);
  });
});

describe("a Schedule of the Agent", () => {
  it("appears in the list of the scenario and fires as a schedule.fired Event", async () => {
    provider.script([
      [reply.toolCall("schedule", { delay: "10m", payload: { customer: "Sam Rivera" } }, "s1")],
      "I made the Schedule.",
      "The reminder is due.",
    ]);
    const { threadKey } = await state();
    await api("POST", `/threads/${threadKey}/turns`, {
      kind: "message",
      parts: [{ type: "text", text: "Remind Sam Rivera in 10 minutes." }],
    });
    await until(threadKey, "turn.completed");
    expect((await state()).schedules).toHaveLength(1);

    await clock.advance("10m");
    const log = await until(threadKey, "turn.completed", 2);
    expect(log).toContainEvent({
      type: "turn.started",
      input: { kind: "event", type: "schedule.fired", payload: { customer: "Sam Rivera" } },
    });
  });

  it("raises a lower Scope ceiling that an earlier Playground stored, thus the Turn of the Agent runs", async () => {
    await karmi.scope(SCOPE).config.set({ ceilings: { scheduling: { maxPending: 2 } } });
    provider.script(["The supplier delivered 24 kettles."]);
    const { threadKey } = await state();
    expect((await karmi.scope(SCOPE).config.get()).document.ceilings?.scheduling).toEqual({ maxPending: 2 });
    await api("POST", `${PATH}/trigger`);
    expect(await until(threadKey, "turn.completed")).not.toContainEvent({ type: "turn.failed" });
  });
});

describe("the external trigger", () => {
  it("sends the supplier Event from the trigger route", async () => {
    provider.script(["The supplier delivered 24 kettles."]);
    const triggered = await api("POST", `${PATH}/trigger`);
    expect(triggered.status).toBe(200);
    const { threadKey } = stateSchema.parse(await triggered.json());
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({ type: "turn.started", input: { kind: "event", type: "supplier.delivery" } });
  });

  it("sends the same Event from the scheduled handler of the Worker", async () => {
    provider.script(["The supplier delivered 24 kettles."]);
    const scheduledTime = Date.parse("2026-09-21T09:00:00Z");
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime, cron: "0 9 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const { threadKey } = await state();
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({
      type: "turn.started",
      input: { kind: "event", type: "supplier.delivery", payload: { at: "2026-09-21T09:00:00.000Z" } },
    });
  });
});

describe("offline delivery to the sample inbox", () => {
  it("delivers the Approval request and the completed Turn of a fired Schedule", async () => {
    provider.script([remind, "I sent the reminder."]);
    const { threadKey } = await schedule("delay", "1m");
    await clock.advance("1m");
    const asked = (await until(threadKey, "approval.requested")).find((event) => event.type === "approval.requested");
    const [approval] = await delivered(1);
    expect(approval).toMatchObject({
      kind: "approval",
      seq: asked?.seq,
      waiting: true,
      call: { tool: "send_reminder" },
    });

    // The operator answers from the inbox, through the Approval route of the Thread.
    await api("POST", `/threads/${threadKey}/approvals/${String(asked?.seq)}`, { decision: "allow", by: "operator" });
    await until(threadKey, "turn.completed");
    const inbox = await delivered(2);
    expect(inbox[0]).toMatchObject({ kind: "approval", waiting: false });
    expect(inbox[1]).toMatchObject({ kind: "completed", text: "I sent the reminder." });
    expect((await state()).reminders.sent).toEqual([{ customer: "Sam Rivera", text: "Order A-1042 is ready." }]);
  });

  it("delivers nothing while a Subscriber is attached, and delivers the next Turn after it detaches", async () => {
    provider.script(["Online.", "Offline."]);
    const { threadKey } = await state();
    const socket = (await karmi.scope(SCOPE).thread(threadKey).socket()).webSocket;
    socket?.accept();
    await api("POST", `${PATH}/trigger`);
    await until(threadKey, "turn.completed");
    // The read of the event log above is no Subscriber. Only the socket stops the delivery.
    await clock.advance(1000);
    expect((await state()).inbox).toEqual([]);

    socket?.close();
    await api("POST", `${PATH}/trigger`);
    await until(threadKey, "turn.completed", 2);
    expect(await delivered(1)).toMatchObject([{ kind: "completed", text: "Offline." }]);
  });
});

describe("the reset of the scenario", () => {
  it("cancels each pending Schedule, empties the inbox and leaves no recurring work", async () => {
    provider.script(["First tick."]);
    const { threadKey } = await schedule("cron", "* * * * *");
    await schedule("delay", "1h");
    await clock.advance("1m");
    await until(threadKey, "turn.completed");
    await delivered(1);

    const reset = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(reset).toMatchObject({ schedules: [], inbox: [], reminders: { sent: [] } });
    expect(reset.threadKey).not.toBe(threadKey);

    provider.script(["A tick after the reset."]);
    await clock.advance("2h");
    expect(provider.requests).toEqual([]);
    expect((await state()).inbox).toEqual([]);
  });

  it("does not change a different scenario", async () => {
    const before: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    await schedule("delay", "1h");
    await api("POST", `${PATH}/reset`);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(before);
  });
});
