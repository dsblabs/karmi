import type { ThreadEvent } from "@karmi/core";
import { z } from "zod";
import { reply } from "@karmi/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { presets, startingSpec } from "../src/assistant";
import { STARTING_STOCK, stockSchema } from "../src/stockroom";
import { api as request, events } from "./client";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);

const stateSchema = z.looseObject({ threadKey: z.string(), agent: z.looseObject({ version: z.number() }).optional() });

/** Decodes the JSON of a scenario state. Each other field stays as the Worker sent it. */
const decodeState = (value: unknown) => stateSchema.parse(value);
const state = async (id: string) => decodeState(await (await api("GET", `/api/scenarios/${id}`)).json());

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

const stock = async () => stockSchema.parse((await state("stockroom")).stock);
const putSpec = (spec: unknown) => api("PUT", "/api/scenarios/agents/spec", spec);
const preset = (id: string) => presets("fake/model").find((item) => item.id === id)?.spec;

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

  it("uses a changed Spec in a new Thread with no deploy", async () => {
    provider.script(["Hello.", "Arr."]);
    await run("agents", "Can I return a kettle?");
    expect(provider.requests.at(-1)?.system).toContain("for 30 days");

    const before = await state("agents");
    const saved = await putSpec(preset("instructions"));
    expect(saved.status).toBe(200);
    const after = decodeState(await saved.json());
    expect(after.agent?.version).toBeGreaterThan(before.agent?.version ?? 0);
    expect(after.threadKey).not.toBe(before.threadKey);
    expect(after).toMatchObject({ prompt: [{ text: expect.stringContaining("pirate") }, {}] });
    await run("agents", "Can I return a kettle?");
    expect(provider.requests.at(-1)?.system).toContain("as a pirate");
    expect(provider.requests.at(-1)?.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("renders the Fragment with the arguments of the stored Spec", async () => {
    expect((await putSpec(preset("fragment"))).status).toBe(200);
    provider.script(["Seven days."]);
    await run("agents", "Can I return a kettle?");
    expect(provider.requests.at(-1)?.system).toContain("for 7 days");
  });

  it("stores a Capability grant in the Scope ceiling and rejects one above it", async () => {
    expect((await putSpec(preset("inside-ceiling"))).status).toBe(200);
    const stored = (await state("agents")).agent?.version;
    const rejected = await putSpec(preset("above-ceiling"));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: {
        code: "agent.spec.invalid",
        issues: [
          expect.objectContaining({ code: "capability.over-ceiling", path: "/capabilities/scheduling/maxPending" }),
        ],
      },
    });
    expect(await state("agents")).toMatchObject({
      agent: { version: stored, spec: { capabilities: { scheduling: { maxPending: 2 } } } },
    });
  });

  it("answers a Spec that is not valid with the issues", async () => {
    const answer = await putSpec({ agentId: "shop-assistant" });
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({ error: { issues: expect.any(Array) } });
  });

  it("refuses a Spec for the Agent of a different scenario", async () => {
    expect((await putSpec({ ...preset("instructions"), agentId: "refund" })).status).toBe(400);
    expect((await api("PUT", "/api/scenarios/agents/spec")).status).toBe(400);
  });

  it("restores the starting Spec and starts a new Thread on reset", async () => {
    const before = await state("agents");
    await putSpec(preset("instructions"));
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
    // The model gets no definition of a denied Tool, deferred or not.
    expect(provider.requests.at(-1)?.tools?.map((tool) => tool.name)).not.toContain("delete_product");
    expect(provider.requests.at(-1)?.system).not.toContain("delete_product");
    expect((await stock()).products).toEqual(STARTING_STOCK.products);
    expect(await state("stockroom")).toMatchObject({
      policy: [{ effect: "deny" }, { match: { annotations: { readOnlyHint: true } }, effect: "allow" }, {}],
      tools: [{ name: "check_stock", annotations: { readOnlyHint: true } }, {}, {}],
    });
  });

  it("does not change the refund scenario on reset", async () => {
    const refund = await state("refund");
    await api("POST", "/api/scenarios/stockroom/reset");
    expect((await state("refund")).threadKey).toBe(refund.threadKey);
  });
});
