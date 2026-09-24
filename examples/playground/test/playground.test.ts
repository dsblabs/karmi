import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { orderSchema, STARTING_ORDER, type Order } from "../src/refund";
import { api, events } from "./client";
import { bare, karmi, refundScript } from "./worker";
import { TOKEN } from "./worker-options";

const BASE = "https://playground.test";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The test reads each JSON shape of the Worker through one function.
function decodeState(value: unknown): { order: Order; threadKey: string } {
  if (!isRecord(value) || typeof value.threadKey !== "string") throw new Error("Not a scenario state.");
  return { order: orderSchema.parse(value.order), threadKey: value.threadKey };
}
const state = async () => decodeState(await (await api(TOKEN, "GET", "/api/scenarios/refund")).json());

async function until(key: string, type: ThreadEvent["type"]): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).some((event) => event.type === type), { timeout: 10_000 })
    .toBe(true);
  return log;
}

/** Sends the suggested prompt through the public routes and waits for the Approval request. */
async function askForRefund(): Promise<{ key: string; request: number }> {
  const { threadKey } = await state();
  const sent = await api(TOKEN, "POST", `/threads/${threadKey}/turns`, {
    kind: "message",
    parts: [{ type: "text", text: "Refund order A-1042." }],
  });
  expect(sent.status).toBe(202);
  const log = await until(threadKey, "approval.requested");
  const request = log.find((event) => event.type === "approval.requested");
  expect(request).toMatchObject({ kind: "tool", tool: "refund_order", input: { orderId: "A-1042", amount: 48 } });
  return { key: threadKey, request: request?.seq ?? 0 };
}

beforeEach(async () => {
  refundScript();
  await api(TOKEN, "POST", "/api/scenarios/refund/reset");
});

describe("the access token", () => {
  it.each([
    ["GET", "/api/playground"],
    ["GET", "/api/scenarios/refund"],
    ["POST", "/api/scenarios/refund/reset"],
    ["GET", "/threads?agent=refund"],
  ])("guards %s %s", async (method, path) => {
    expect((await api(null, method, path)).status).toBe(401);
    expect((await api("wrong", method, path)).status).toBe(401);
  });

  it("lets nobody in when setup made no token", async () => {
    const response = await bare.fetch(new Request(`${BASE}/api/playground`, { headers: { authorization: "Bearer " } }));
    expect(response.status).toBe(401);
  });
});

describe("GET /api/playground", () => {
  it("shows the Provider and the model, and explains a model limit before the scenario runs", async () => {
    const body: unknown = await (await api(TOKEN, "GET", "/api/playground")).json();
    expect(body).toMatchObject({ provider: { id: "openrouter", label: "OpenRouter", model: "test/model" } });
    const text = JSON.stringify(body);
    expect(text).toContain("needs a model that supports Tool calls");
    expect(text).not.toContain(TOKEN);
  });

  it("lists scenarios that are not built as incomplete, with their prerequisites", async () => {
    const body: unknown = await (await api(TOKEN, "GET", "/api/playground")).json();
    expect(body).toMatchObject({
      scenarios: expect.arrayContaining([
        expect.objectContaining({ id: "refund", status: "ready" }),
        expect.objectContaining({ id: "http", status: "incomplete" }),
      ]),
    });
  });
});

describe("the refund scenario", () => {
  it("starts with the sample order", async () => {
    expect((await state()).order).toEqual(STARTING_ORDER);
  });

  it("refunds the sample order after an allow", async () => {
    const { key, request } = await askForRefund();
    expect((await state()).order.status).toBe("delivered");
    const answer = await api(TOKEN, "POST", `/threads/${key}/approvals/${request}`, { decision: "allow" });
    expect(answer.status).toBe(204);
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "approval.resolved", decision: "allow" });
    expect(log).toContainEvent({ type: "tool.result", name: "refund_order" });
    expect((await state()).order).toMatchObject({ status: "refunded", refund: { amount: 48 } });
  });

  it("leaves the sample order unchanged after a deny", async () => {
    const { key, request } = await askForRefund();
    await api(TOKEN, "POST", `/threads/${key}/approvals/${request}`, { decision: "deny", reason: "Not now." });
    const log = await until(key, "turn.completed");
    expect(log).toContainEvent({ type: "approval.resolved", decision: "deny" });
    expect((await state()).order).toEqual(STARTING_ORDER);
  });

  it("keeps its state until a reset", async () => {
    const { key, request } = await askForRefund();
    await api(TOKEN, "POST", `/threads/${key}/approvals/${request}`, { decision: "allow" });
    await until(key, "turn.completed");
    const again = await state();
    expect(again.threadKey).toBe(key);
    expect(again.order.status).toBe("refunded");
  });
});

describe("reset", () => {
  it("cancels the pending Approval, restores the order and starts a new Thread", async () => {
    const { key, request } = await askForRefund();
    const reset = decodeState(await (await api(TOKEN, "POST", "/api/scenarios/refund/reset")).json());
    expect(reset.order).toEqual(STARTING_ORDER);
    expect(reset.threadKey).not.toBe(key);
    const late = await api(TOKEN, "POST", `/threads/${key}/approvals/${request}`, { decision: "allow" });
    expect(late.ok).toBe(false);
    expect((await state()).order).toEqual(STARTING_ORDER);
  });

  it("keeps a stored credential", async () => {
    const credentials = karmi.scope("sample-a").credentials;
    await credentials.put("kept", "secret-value");
    await api(TOKEN, "POST", "/api/scenarios/refund/reset");
    expect(await credentials.describe("kept")).toMatchObject({ version: 1 });
  });
});

describe("before setup", () => {
  it("tells that no Provider is set up", async () => {
    const { viewScenario, SCENARIOS } = await import("../src/scenarios");
    const [refund] = SCENARIOS;
    if (!refund) throw new Error("The refund scenario is missing.");
    expect(viewScenario(refund, undefined, { hasLoader: true })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("pnpm setup"),
    });
  });
});
