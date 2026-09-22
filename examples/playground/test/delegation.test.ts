import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BUYER, MANAGER, purchasesSchema, STARTING_PURCHASES } from "../src/purchases";
import { api as request, events } from "./client";
import { delegationReplies } from "./script";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = "/api/scenarios/delegation";

const childSchema = z.object({
  threadKey: z.string(),
  threadId: z.string(),
  agent: z.string(),
  parent: z.object({ threadKey: z.string(), callId: z.string() }),
  state: z.string(),
  paused: z.optional(z.string()),
});

const usageSchema = z.looseObject({
  kind: z.string(),
  agent: z.string(),
  threadId: z.string(),
  parent: z.optional(z.object({ threadKey: z.string(), callId: z.string() })),
  input: z.number(),
  output: z.number(),
});

const stateSchema = z.looseObject({
  threadKey: z.string(),
  purchases: purchasesSchema,
  turn: z.looseObject({
    state: z.string(),
    paused: z.optional(z.string()),
    delegated: z.optional(z.object({ children: z.number(), active: z.number() })),
  }),
  children: z.array(childSchema),
  usage: z.array(usageSchema),
});

/** Reads the state of the scenario through its route. */
const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());

/** Waits until the log of the Thread has this number of events of this type and returns the log. */
async function until(key: string, type: ThreadEvent["type"], count = 1): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).filter((event) => event.type === type).length, { timeout: 10_000 })
    .toBe(count);
  return log;
}

/** Sends one message to the Thread of the scenario. */
async function send(key: string, text: string): Promise<void> {
  const sent = await api("POST", `/threads/${key}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
}

/** Answers the Approval at `seq` on the parent Thread. */
async function answer(key: string, seq: number, decision: "allow" | "deny"): Promise<void> {
  const answered = await api("POST", `/threads/${key}/approvals/${String(seq)}`, { decision, by: "operator" });
  expect(answered.status).toBe(204);
}

/** The requests of the parent Agent see the manager instructions. The child Agent has its own. */
const isParent = (system: string | undefined) => system?.includes("manage a small shop") ?? false;

/** Starts the shared script of the scenario. A prompt that names filter paper gets two tasks. */
const script = () => provider.script(delegationReplies);

/** Waits for the bubbled Approval of the child on the parent Thread and returns its request event. */
async function childApproval(key: string, count = 1) {
  const log = await until(key, "approval.requested", count);
  const requested = log.filter((event) => event.type === "approval.requested").at(count - 1);
  expect(requested).toMatchObject({ kind: "tool", tool: "place_order", child: { threadId: expect.any(String) } });
  return requested as Extract<ThreadEvent, { type: "approval.requested" }>;
}

beforeEach(async () => {
  await api("POST", `${PATH}/reset`);
});

describe("the state of the scenario", () => {
  it("starts with the sample purchase system, no child Thread and no Usage record", async () => {
    const now = await state();
    expect(now.purchases).toEqual(STARTING_PURCHASES);
    expect(now.turn.state).toBe("idle");
    expect(now.children).toEqual([]);
    expect(now.usage).toEqual([]);
  });
});

describe("a delegated task", () => {
  it("starts a child Thread of the parent, and the child result becomes the delegate result", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans.");
    const requested = await childApproval(threadKey);
    // The parent parks on the delegate call, and the state shows the child with its parent link.
    const parked = await state();
    expect(parked.turn).toMatchObject({ state: "parked", paused: "job", delegated: { children: 1, active: 1 } });
    expect(parked.children).toHaveLength(1);
    const child = parked.children[0] ?? { threadKey: "", threadId: "" };
    expect(child).toMatchObject({
      agent: BUYER,
      threadId: requested.child?.threadId,
      parent: { threadKey, callId: expect.stringMatching(/^manager-\d+:\d+$/) },
      paused: "approval",
    });
    expect(child.threadId.startsWith(`${MANAGER}-`)).toBe(true);
    // The child got the task text only, not the message of the operator.
    const childRequest = provider.requests.find((request) => !isParent(request.system));
    expect(JSON.stringify(childRequest?.messages)).toContain("espresso beans");
    expect(JSON.stringify(childRequest?.messages)).not.toContain("Order beans.");

    await answer(threadKey, requested.seq, "allow");
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({ type: "delegation.started", childKey: child.threadKey });
    expect(log).toContainEvent({
      type: "delegation.completed",
      childKey: child.threadKey,
      result: { content: [{ type: "text", text: "I placed the order." }] },
    });
    expect(log).toContainEvent({ type: "tool.result", name: "delegate", isError: false });
    // The parent log has the Approval of the child, and no Tool call of the child.
    expect(log.filter((event) => event.type === "tool.call").map((event) => event.name)).toEqual(["delegate"]);
    expect(log).toContainEvent({ type: "approval.resolved", decision: "allow", request: requested.seq });
    const done = await state();
    expect(done.purchases.orders).toEqual([
      { id: "O-1", supplierId: "S-2", item: "Bag of espresso beans", quantity: 20 },
    ]);
    expect(done.turn).toMatchObject({ state: "idle" });
    expect(done.children[0]).toMatchObject({ state: "idle" });
    // The child log has its own Turn with the Tool calls and the answer of the child.
    const childLog = await events(child.threadKey);
    expect(childLog.filter((event) => event.type === "tool.call").map((event) => event.name)).toEqual([
      "list_suppliers",
      "place_order",
    ]);
    expect(childLog).toContainEvent({ type: "approval.resolved", decision: "allow", by: "operator" });
    expect(childLog).toContainEvent({ type: "turn.completed", stopReason: "end_turn" });
  });

  it("gives the child an error result on deny, and the child answers without an order", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans.");
    const requested = await childApproval(threadKey);
    await answer(threadKey, requested.seq, "deny");
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({
      type: "delegation.completed",
      result: { content: [{ type: "text", text: "No order was placed." }] },
    });
    const childLog = await events(log.find((event) => event.type === "delegation.completed")?.childKey ?? "");
    expect(childLog).toContainEvent({ type: "tool.result", name: "place_order", isError: true });
    expect((await state()).purchases.orders).toEqual([]);
  });

  it("runs two children at the same time, each with its own Approval", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans and filter paper.");
    const second = await childApproval(threadKey, 2);
    const first = (await events(threadKey)).find((event) => event.type === "approval.requested");
    expect((await state()).turn.delegated).toEqual({ children: 2, active: 2 });
    expect((await state()).children).toHaveLength(2);
    await answer(threadKey, first?.seq ?? 0, "allow");
    await answer(threadKey, second.seq, "allow");
    await until(threadKey, "turn.completed");
    const { purchases, turn } = await state();
    expect(purchases.orders.map((order) => order.supplierId).sort()).toEqual(["S-2", "S-3"]);
    expect(turn.delegated).toBeUndefined();
  });
});

describe("cancellation", () => {
  it("cancels the child with the parent Turn, and the child Turn fails with cancelled", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans.");
    await childApproval(threadKey);
    const [child] = (await state()).children;
    expect((await api("POST", `/threads/${threadKey}/cancel`)).status).toBe(204);
    const log = await until(threadKey, "turn.failed");
    expect(log).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    const childLog = await until(child?.threadKey ?? "", "turn.failed");
    expect(childLog).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    expect((await state()).purchases.orders).toEqual([]);
  });
});

describe("Usage records", () => {
  it("lists the records of the parent and the child, with the parent link on the child records only", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans.");
    const requested = await childApproval(threadKey);
    await answer(threadKey, requested.seq, "allow");
    await until(threadKey, "turn.completed");
    const { usage, children } = await state();
    const parentRecords = usage.filter((record) => record.agent === MANAGER);
    const childRecords = usage.filter((record) => record.agent === BUYER);
    expect(parentRecords).toHaveLength(2);
    expect(childRecords).toHaveLength(3);
    for (const record of parentRecords) expect(record.parent).toBeUndefined();
    for (const record of childRecords)
      expect(record).toMatchObject({
        threadId: children[0]?.threadId,
        parent: { threadKey, callId: expect.stringMatching(/^manager-\d+:\d+$/) },
      });
    // No record appears two times: each Thread records its own spend.
    const keys = usage.map((record) => `${record.threadId}:${String(record.seq)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the reset of the scenario", () => {
  it("cancels the parked Turn, deletes the parent and the child and restores the sample data", async () => {
    script();
    const { threadKey } = await state();
    await send(threadKey, "Order beans.");
    await childApproval(threadKey);
    const [child] = (await state()).children;
    const after = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(after.threadKey).not.toBe(threadKey);
    expect(after.children).toEqual([]);
    expect(after.usage).toEqual([]);
    expect(after.purchases).toEqual(STARTING_PURCHASES);
    expect(after.turn.state).toBe("idle");
    expect((await api("GET", `/threads/${threadKey}`)).status).toBe(404);
    expect((await api("GET", `/threads/${child?.threadKey ?? ""}`)).status).toBe(404);
  });

  it("does not change the refund scenario", async () => {
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    await api("POST", `${PATH}/reset`);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
  });
});
