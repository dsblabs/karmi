import { defineAgent, defineTool, type ScriptLimits } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { errorResult } from "./results";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the isolate Scripts scenario. It is also the id of its Agent. */
export const SCRIPTS = "scripts";

/**
 * The Script limits of the Agent. They are lower than the defaults, thus a guided Script can reach each one in a
 * few seconds. Local workerd does not enforce `cpuMs`.
 */
export const SCRIPT_LIMITS: ScriptLimits = { cpuMs: 50, wallMs: 10000, maxToolCalls: 10 };

const orderSchema = z.object({
  id: z.string(),
  customer: z.string(),
  total: z.number(),
  status: z.enum(["open", "shipped", "packed", "cancelled"]),
});

/** One order of the sample order system. */
export type ScriptOrder = z.infer<typeof orderSchema>;

// The orders do not change. The stored data has only what a Tool changed, thus one atomic push records a change.
const ORDERS: readonly ScriptOrder[] = [
  { id: "B-201", customer: "Ana Lima", total: 32, status: "open" },
  { id: "B-202", customer: "Ben Okafor", total: 18, status: "open" },
  { id: "B-203", customer: "Chen Wei", total: 55, status: "open" },
  { id: "B-204", customer: "Dana Cruz", total: 12, status: "shipped" },
];

/** The schema of the stored changes of the sample order system. */
export const orderChangesSchema = z.object({
  packed: z.array(z.string()).default([]),
  cancelled: z.array(z.string()).default([]),
});

type OrderChanges = z.infer<typeof orderChangesSchema>;

/** Decodes the stored changes. Data that is absent or not valid gives no change. */
const decodeChanges = (data: string | undefined): OrderChanges =>
  decodeSample(orderChangesSchema, { packed: [], cancelled: [] }, data);

/** Returns the sample orders with the changes that the Tools made. */
export function decodeScriptOrders(data: string | undefined): ScriptOrder[] {
  const { packed, cancelled } = decodeChanges(data);
  return ORDERS.map((order) => ({
    ...order,
    status: cancelled.includes(order.id) ? "cancelled" : packed.includes(order.id) ? "packed" : order.status,
  }));
}

const orderSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, SCRIPTS);
const readOrders = async (scope: string) => decodeScriptOrders((await orderSystem(scope).read()).data);
const findOrder = async (scope: string, id: string) => (await readOrders(scope)).find((order) => order.id === id);
const orderId = z.string().describe("The order id, for example B-201");

/** Lists the sample orders, or the orders with one status. */
export const findOrders = defineTool({
  name: "find_orders",
  description: "List the orders of the sample order system",
  input: z.object({ status: orderSchema.shape.status.optional().describe("Only the orders with this status") }),
  annotations: { readOnlyHint: true },
  async execute({ status }, { scope }) {
    const orders = (await readOrders(scope)).filter((order) => status === undefined || order.status === status);
    // A Script gets `structuredContent`. The model gets the text.
    return {
      content: [{ type: "text", text: orders.map((order) => `${order.id}: ${order.status}`).join("\n") || "None." }],
      structuredContent: { orders },
    };
  },
});

/** Reads one sample order. */
export const readOrder = defineTool({
  name: "read_order",
  description: "Read one order of the sample order system",
  input: z.object({ orderId }),
  annotations: { readOnlyHint: true },
  async execute(input, { scope }) {
    const order = await findOrder(scope, input.orderId);
    if (!order) return errorResult(`There is no order ${input.orderId}.`);
    return { content: [{ type: "text", text: JSON.stringify(order) }], structuredContent: order };
  },
});

/** Packs one open order. A rule of the Policy allows it by name. */
export const packBox = defineTool({
  name: "pack_box",
  description: "Pack the box of one open order",
  input: z.object({ orderId }),
  annotations: { destructiveHint: false, idempotentHint: true },
  async execute(input, { scope }) {
    const order = await findOrder(scope, input.orderId);
    if (order?.status !== "open") return errorResult(`Order ${input.orderId} is not open.`);
    await orderSystem(scope).push("packed", JSON.stringify(input.orderId), ORDERS.length);
    return `Packed the box of ${input.orderId}.`;
  },
});

/** Cancels one order. No Policy rule matches it, thus a direct call waits for an Approval and a Script never gets it. */
export const cancelOrder = defineTool({
  name: "cancel_order",
  description: "Cancel one order of the sample order system",
  input: z.object({ orderId }),
  annotations: { destructiveHint: true, idempotentHint: true },
  async execute(input, { scope }) {
    const order = await findOrder(scope, input.orderId);
    if (!order) return errorResult(`There is no order ${input.orderId}.`);
    await orderSystem(scope).push("cancelled", JSON.stringify(input.orderId), ORDERS.length);
    return `Cancelled ${input.orderId}.`;
  },
});

/** Defines the Agent of the isolate Scripts scenario for the model that setup selected. */
export const scriptsAgent = (model: string) =>
  defineAgent({
    agentId: SCRIPTS,
    name: "Script desk",
    instructions: [
      {
        text: "You work at the order desk of a small shop. When the operator gives you a script, run it with run_script exactly as written. Do not change the code, and do not call another tool. Then tell the result or the error in one or two sentences.",
      },
    ],
    model: { id: model },
    tools: ["find_orders", "read_order", "pack_box", "cancel_order"],
    // Rules are tried in order and the first match decides. No rule matches `cancel_order`, so it asks for an Approval.
    policy: [
      { match: { annotations: { readOnlyHint: true } }, effect: "allow" },
      { match: { tool: ["pack_box", "run_script"] }, effect: "allow" },
    ],
    // `allowed` gives a Script each Tool that the Policy allows. A Script cannot wait for an Approval.
    capabilities: { scripts: { tier: "isolate", tools: "allowed", limits: SCRIPT_LIMITS } },
  });

const script = (code: string) => `Run this script with run_script. Do not change it.\n\n\`\`\`js\n${code}\n\`\`\``;

/** The prompts that the scenario suggests. Each one has the Script that the model runs. The operator can edit each one. */
export const SCRIPT_PROMPTS = [
  {
    label: "Tool calls",
    text: script(`export default async () => {
  const { orders } = await tools.find_orders({ status: "open" });
  const details = await Promise.all(orders.map((order) => tools.read_order({ orderId: order.id })));
  console.log(\`Read \${details.length} open orders\`);
  return { count: details.length, total: details.reduce((sum, order) => sum + order.total, 0) };
};`),
  },
  {
    label: "Tool that needs an Approval",
    text: script(`export default async () => {
  console.log("Tools of this Script: " + Object.keys(tools).join(", "));
  return await tools.cancel_order({ orderId: "B-201" });
};`),
  },
  {
    label: "Network",
    text: script(`export default async () => {
  const response = await fetch("https://example.com");
  return response.status;
};`),
  },
  {
    label: "Tool-call limit",
    text: script(`export default async () => {
  for (let call = 1; call <= 12; call++) {
    await tools.read_order({ orderId: "B-201" });
    console.log(\`Call \${call} finished\`);
  }
  return "Twelve calls";
};`),
  },
  {
    label: "Time limit",
    text: script(`export default async () => {
  console.log("Waiting for 60 seconds");
  await new Promise((resolve) => setTimeout(resolve, 60000));
  return "Finished";
};`),
  },
  {
    label: "CPU limit",
    text: script(`export default async () => {
  let sum = 0;
  for (let step = 0; step < 300000000; step++) sum += step % 7;
  return sum;
};`),
  },
  {
    label: "Cancel",
    text: script(`export default async () => {
  const { orders } = await tools.find_orders({ status: "open" });
  for (const order of orders) {
    await tools.pack_box({ orderId: order.id });
    console.log(\`Packed \${order.id}\`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return "Packed each open order";
};`),
  },
];
