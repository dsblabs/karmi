import type { ThreadEvent } from "@karmi/core";
import { reply } from "@karmi/core/testing";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { presets, startingSpec } from "../src/assistant";
import { STARTING_STOCK, stockSchema } from "../src/stockroom";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

const BASE = "https://playground.test";

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The test reads the JSON of a scenario state through one function.
async function state(id: string): Promise<Record<string, unknown> & { threadKey: string }> {
  const value: unknown = await (await api("GET", `/api/scenarios/${id}`)).json();
  if (!isRecord(value) || typeof value.threadKey !== "string") throw new Error("Not a scenario state.");
  return { ...value, threadKey: value.threadKey };
}

/** Sends one prompt through the public routes and returns the event log after the Turn completes. */
async function run(id: string, text: string): Promise<ThreadEvent[]> {
  const { threadKey } = await state(id);
  const turns = (log: ThreadEvent[]) => log.filter((event) => event.type === "turn.completed").length;
  const before = turns(await events(threadKey));
  const sent = await api("POST", `/threads/${threadKey}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
  let log: ThreadEvent[] = [];
  await expect.poll(async () => turns((log = await events(threadKey))), { timeout: 10_000 }).toBeGreaterThan(before);
  return log;
}

async function events(key: string): Promise<ThreadEvent[]> {
  const value: unknown = await (await api("GET", `/threads/${key}/events`)).json();
  if (!Array.isArray(value)) throw new Error("Not an event list.");
  return value as ThreadEvent[];
}

const stock = async () => stockSchema.parse((await state("stockroom")).stock);
const putSpec = async (spec: unknown) => (await api("PUT", "/api/scenarios/agents/spec", spec)).json();

describe("the Agent Spec scenario", () => {
  beforeEach(async () => {
    await api("POST", "/api/scenarios/agents/reset");
  });

  it("stores its Agent at runtime and shows what each Prompt entry gives", async () => {
    expect(await state("agents")).toMatchObject({
      agent: { spec: { agentId: "shop-assistant" } },
      prompt: [{ source: "Text" }, { source: "Fragment shop_policy", text: expect.stringContaining("for 30 days") }],
    });
  });

  it("uses a changed Spec in the next Turn with no deploy", async () => {
    provider.script(["Hello.", "Arr."]);
    await run("agents", "Can I return a kettle?");
    expect(provider.requests.at(-1)?.system).toContain("for 30 days");

    const [instructions, fragment] = presets("fake/model");
    expect(await putSpec(fragment?.spec)).toMatchObject({ ok: true });
    expect(await putSpec(instructions?.spec)).toMatchObject({ ok: true, version: expect.any(Number) });
    expect(await state("agents")).toMatchObject({ prompt: [{ text: expect.stringContaining("pirate") }, {}] });
    await run("agents", "Can I return a kettle?");
    expect(provider.requests.at(-1)?.system).toContain("as a pirate");
  });

  it("stores a Capability grant in the Scope ceiling and rejects one above it", async () => {
    const [, , inside, above] = presets("fake/model");
    expect(await putSpec(inside?.spec)).toMatchObject({ ok: true });
    const { version } = (await state("agents")).agent as { version: number };
    expect(await putSpec(above?.spec)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ code: "capability.over-ceiling", path: "/capabilities/scheduling/maxPending" }),
      ],
    });
    expect(await state("agents")).toMatchObject({
      agent: { version, spec: { capabilities: { scheduling: { maxPending: 2 } } } },
    });
  });

  it("answers a body that is not an Agent Spec with the issues", async () => {
    expect(await putSpec({ agentId: "shop-assistant" })).toMatchObject({ ok: false, issues: expect.any(Array) });
  });

  it("restores the starting Spec and starts a new Thread on reset", async () => {
    const before = await state("agents");
    await putSpec(presets("fake/model")[0]?.spec);
    const after: unknown = await (await api("POST", "/api/scenarios/agents/reset")).json();
    expect(after).toMatchObject({ agent: { spec: { instructions: startingSpec("fake/model").instructions } } });
    expect(after).not.toMatchObject({ threadKey: before.threadKey });
  });
});

describe("the Tools scenario", () => {
  beforeEach(async () => {
    await api("POST", "/api/scenarios/stockroom/reset");
  });

  it("refuses a deferred Tool until tool_search loads it, then changes the stock", async () => {
    provider.script([
      [reply.toolCall("adjust_stock", { sku: "MUG-01", change: -2 }, "c0")],
      [reply.toolCall("tool_search", { query: "select:adjust_stock" }, "c1")],
      [reply.toolCall("adjust_stock", { sku: "MUG-01", change: -2 }, "c2")],
      "Done.",
    ]);
    const log = await run("stockroom", "We sold 2 mugs.");
    expect(log).toContainEvent({ type: "tool.result", id: "c0", isError: true });
    expect(log).toContainEvent({ type: "tools.loaded", names: ["adjust_stock"] });
    expect(log).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: false,
      structuredContent: { sku: "MUG-01", stock: 10 },
    });
    expect((await stock()).products[0]).toMatchObject({ stock: 10 });
  });

  it("refuses an input that does not match the schema, and the Hook writes each call to the audit log", async () => {
    provider.script([
      [reply.toolCall("tool_search", { query: "select:adjust_stock" }, "c1")],
      [reply.toolCall("adjust_stock", { sku: "MUG-01", change: 5000 }, "c2")],
      "I cannot add that many.",
    ]);
    const log = await run("stockroom", "Add 5000 mugs.");
    expect(log).toContainEvent({ type: "tool.result", id: "c2", isError: true });
    const now = await stock();
    expect(now.products).toEqual(STARTING_STOCK.products);
    expect(now.audit).toEqual([
      expect.stringContaining("tool_search"),
      expect.stringMatching(/^adjust_stock .*error$/),
    ]);
  });

  it("gives the Skill body and its Tool only after use_skill", async () => {
    provider.script([
      [reply.toolCall("use_skill", { name: "restock" }, "c1")],
      [reply.toolCall("order_supplier", { sku: "KET-02", quantity: 24 }, "c2")],
      "Ordered.",
    ]);
    const log = await run("stockroom", "Restock the kettle.");
    expect(provider.requests.at(-3)?.tools?.map((tool) => tool.name)).not.toContain("order_supplier");
    expect(log).toContainEvent({ type: "tools.loaded", skill: { name: "restock" } });
    expect((await stock()).supplierOrders).toEqual([{ sku: "KET-02", quantity: 24 }]);
  });

  it("does not run a Tool that the Permission Policy denies", async () => {
    provider.script([[reply.toolCall("delete_product", { sku: "KET-02" }, "c1")], "I cannot delete it."]);
    const log = await run("stockroom", "Delete the kettle.");
    expect(log).toContainEvent({ type: "tool.result", id: "c1", isError: true });
    expect((await stock()).products).toEqual(STARTING_STOCK.products);
    expect(await state("stockroom")).toMatchObject({ policy: [{ effect: "deny" }, { effect: "allow" }] });
  });

  it("does not change the refund scenario on reset", async () => {
    const refund = await state("refund");
    await api("POST", "/api/scenarios/stockroom/reset");
    expect((await state("refund")).threadKey).toBe(refund.threadKey);
  });
});
