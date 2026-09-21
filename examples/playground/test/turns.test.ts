import type { ThreadEvent } from "@karmi/core";
import { reply } from "@karmi/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatchSchema, STARTING_DISPATCH } from "../src/dispatch";
import { api as request, events } from "./client";
import { clock, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);

const stateSchema = z.looseObject({
  threadKey: z.string(),
  dispatch: dispatchSchema,
  turn: z.looseObject({ state: z.string(), paused: z.optional(z.string()) }),
});

/** Reads the state of the Turn control scenario through its route. */
const state = async () => stateSchema.parse(await (await api("GET", "/api/scenarios/turns")).json());

/** Waits until the log of the Thread has an event of this type and returns the log. */
async function until(key: string, type: ThreadEvent["type"]): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).some((event) => event.type === type), { timeout: 10_000 })
    .toBe(true);
  return log;
}

/** Sends one message to the Thread of the scenario. `steer` adds it to the Turn that runs now. */
async function send(key: string, text: string, steer = false): Promise<void> {
  const sent = await api("POST", `/threads/${key}/turns`, {
    kind: "message",
    parts: [{ type: "text", text }],
    steer,
  });
  expect(sent.status).toBe(202);
}

const packed = (dispatch: z.infer<typeof dispatchSchema>) => dispatch.parcels.filter((parcel) => parcel.packed).length;

/** Packs parcels until the Turn spends its budget and asks to continue. Returns the Thread and the request seq. */
async function runOutOfBudget(): Promise<{ key: string; request: number }> {
  provider.script([
    [reply.toolCall("pack_parcel", { parcelId: "P-1" }, "c1")],
    [reply.toolCall("pack_parcel", { parcelId: "P-2" }, "c2")],
    [reply.toolCall("pack_parcel", { parcelId: "P-3" }, "c3")],
    [reply.toolCall("pack_parcel", { parcelId: "P-4" }, "c4")],
    "Every parcel is packed.",
  ]);
  const { threadKey } = await state();
  await send(threadKey, "Pack every parcel.");
  const log = await until(threadKey, "approval.requested");
  const asked = log.find((event) => event.type === "approval.requested");
  expect(asked).toMatchObject({ kind: "continue" });
  return { key: threadKey, request: asked?.seq ?? 0 };
}

/** Books the courier and waits until the Turn parks for the Job. */
async function runToJob(): Promise<{ key: string; log: ThreadEvent[] }> {
  provider.script([
    [reply.toolCall("pack_parcel", { parcelId: "P-1" }, "c1")],
    [reply.toolCall("book_courier", { note: "Ring the bell." }, "c2")],
    "The courier answered.",
  ]);
  const { threadKey } = await state();
  await send(threadKey, "Pack the mug parcel and book the courier.");
  const log = await until(threadKey, "job.started");
  await expect.poll(async () => (await state()).turn.paused, { timeout: 10_000 }).toBe("job");
  return { key: threadKey, log };
}

beforeEach(async () => {
  await api("POST", "/api/scenarios/turns/reset");
});

describe("the Turn control scenario", () => {
  it("starts with the sample dispatch and an idle Thread", async () => {
    const now = await state();
    expect(now.dispatch).toEqual(STARTING_DISPATCH);
    expect(now.turn.state).toBe("idle");
  });

  it("parks for a continuation Approval when the Turn spends its budget", async () => {
    const { key } = await runOutOfBudget();
    const now = await state();
    expect(packed(now.dispatch)).toBe(3);
    expect(now.turn).toMatchObject({ state: "parked", paused: "budget" });
    expect(await events(key)).toContainEvent({ type: "turn.paused", reason: "budget" });
  });

  it("gives the Turn a new budget after an allow", async () => {
    const { key, request } = await runOutOfBudget();
    expect((await api("POST", `/threads/${key}/approvals/${request}`, { decision: "allow" })).status).toBe(204);
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "turn.completed", stopReason: "end_turn" });
    expect(packed((await state()).dispatch)).toBe(4);
  });

  it("ends the Turn on the budget after a deny", async () => {
    const { key, request } = await runOutOfBudget();
    await api("POST", `/threads/${key}/approvals/${request}`, { decision: "deny", reason: "That is enough." });
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "turn.completed", stopReason: "budget" });
    expect(packed((await state()).dispatch)).toBe(3);
  });

  it("ends the Turn on the budget when the continuation Approval gets no answer", async () => {
    const { key } = await runOutOfBudget();
    // The default timeout of an Approval is 24 hours. A request with no answer becomes a deny.
    await clock.advance("25h");
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "approval.resolved", decision: "deny", source: "timeout" });
    expect(log).toContainEvent({ type: "turn.completed", stopReason: "budget" });
  });

  it("cancels a Turn that runs, and the Thread becomes idle", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // The model Step waits, thus the cancel arrives while the Turn runs and not while it is parked.
    provider.script(async () => {
      await held;
      return "Packed.";
    });
    const { threadKey } = await state();
    await send(threadKey, "Pack every parcel.");
    await expect.poll(async () => (await state()).turn.state, { timeout: 10_000 }).toBe("running");
    expect((await api("POST", `/threads/${threadKey}/cancel`)).status).toBe(204);
    release();
    const log = await until(threadKey, "turn.failed");
    expect(log).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    expect((await state()).turn.state).toBe("idle");
  });

  it("adds a steered input to the Turn that runs now", async () => {
    const { key, request } = await runOutOfBudget();
    await send(key, "Pack the beans parcel last.", true);
    await api("POST", `/threads/${key}/approvals/${request}`, { decision: "allow" });
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "turn.input", steer: true });
    // One Turn ran, thus the steered input did not start a second one.
    expect(log.filter((event) => event.type === "turn.started")).toHaveLength(1);
    const last = provider.requests.at(-1)?.messages.filter((message) => message.role === "user");
    expect(JSON.stringify(last)).toContain("beans parcel last");
  });

  it("keeps an input without steer for the next Turn", async () => {
    const { key, request } = await runOutOfBudget();
    await send(key, "Tell me what is left.");
    provider.script([
      [reply.toolCall("pack_parcel", { parcelId: "P-4" }, "c4")],
      "Every parcel is packed.",
      "Nothing is left.",
    ]);
    await api("POST", `/threads/${key}/approvals/${request}`, { decision: "allow" });
    let log: ThreadEvent[] = [];
    await expect
      .poll(async () => (log = await events(key)).filter((event) => event.type === "turn.started").length, {
        timeout: 10_000,
      })
      .toBe(2);
    const started = log.filter((event) => event.type === "turn.started");
    expect(JSON.stringify(started.at(-1)?.input)).toContain("what is left");
  });

  it("parks for the courier Job and resumes when the operator reports the collection", async () => {
    const { key, log } = await runToJob();
    expect(log).toContainEvent({ type: "turn.paused", reason: "job" });
    expect((await state()).dispatch.booking).toMatchObject({ status: "waiting", parcels: 1 });

    const reported = await api("POST", "/api/scenarios/turns/job", { report: "collected" });
    expect(reported.status).toBe(200);
    const after = await until(key, "turn.completed");
    expect(after).toContainEvent({ type: "turn.resumed", reason: "job" });
    expect(after).toContainEvent({ type: "tool.result", name: "book_courier", isError: false });
    expect((await state()).dispatch.booking).toMatchObject({ status: "collected" });
  });

  it("gives the model an error result when the courier reports a failure", async () => {
    const { key } = await runToJob();
    expect((await api("POST", "/api/scenarios/turns/job", { report: "failed" })).status).toBe(200);
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "job.failed" });
    expect(log).toContainEvent({ type: "tool.result", name: "book_courier", isError: true });
    expect((await state()).dispatch.booking).toMatchObject({ status: "failed" });
  });

  it("refuses a Job report when no Turn waits for one", async () => {
    const answer = await api("POST", "/api/scenarios/turns/job", { report: "collected" });
    expect(answer.status).toBe(409);
    expect((await api("POST", "/api/scenarios/turns/job", { report: "later" })).status).toBe(400);
  });

  it("cancels a parked Turn and keeps the action that the Tool already made", async () => {
    const { key } = await runToJob();
    expect((await api("POST", `/threads/${key}/cancel`)).status).toBe(204);
    const log = await until(key, "turn.failed");
    expect(log).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    const now = await state();
    // Cancellation ends the Turn. It does not undo the booking or the packing of the parcel.
    expect(now.dispatch.booking).toMatchObject({ status: "waiting" });
    expect(packed(now.dispatch)).toBe(1);
    expect(now.turn.state).toBe("idle");
  });

  it("cancels the parked Turn and restores the sample data on reset", async () => {
    const { key } = await runToJob();
    const after = stateSchema.parse(await (await api("POST", "/api/scenarios/turns/reset")).json());
    expect(after.threadKey).not.toBe(key);
    expect(after.dispatch).toEqual(STARTING_DISPATCH);
    expect(after.turn.state).toBe("idle");
    // The Turn of the deleted Thread no longer waits, thus a late Job report has no Turn to resume.
    expect((await api("POST", "/api/scenarios/turns/job", { report: "collected" })).status).toBe(409);
  });

  it("does not change the refund scenario on reset", async () => {
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    await api("POST", "/api/scenarios/turns/reset");
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
  });
});
