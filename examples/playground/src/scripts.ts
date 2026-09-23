import { defineAgent, defineTool, type ScriptLimits, type ThreadEvent } from "@karmi/core";
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
    const order = (await readOrders(scope)).find((item) => item.id === input.orderId);
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
    const order = (await readOrders(scope)).find((item) => item.id === input.orderId);
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
    const order = (await readOrders(scope)).find((item) => item.id === input.orderId);
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

const scriptInputSchema = z.object({ code: z.string(), description: z.string().optional() });

// The text of a `run_script` result. The Harness writes it as JSON.
const scriptResultSchema = z.object({
  value: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  logs: z.array(z.string()).default([]),
});

/** One Tool call that a Script made, from the `tool.call` and `tool.result` events with its `parentCallId`. */
export interface NestedCall {
  /** The call id of the nested call, `{threadId}:{seq}`. */
  callId: string;
  /** The call id of the `run_script` call that made this call. */
  parentCallId: string;
  name: string;
  input: unknown;
  /** Undefined while the call runs. */
  isError?: boolean;
}

/** One `run_script` call of the Thread, with its result, its logs and the Tool calls that the Script made. */
export interface ScriptRun {
  /** The call id of the `run_script` call, `{threadId}:{seq}`. */
  callId: string;
  code: string;
  /** `stopped` is a Script whose Turn ended before the Script reported a result. */
  state: "running" | "done" | "failed" | "stopped";
  value?: unknown;
  error?: string;
  /** What the error means, in plain words, when the scenario knows the cause. */
  explanation?: string;
  logs: string[];
  calls: NestedCall[];
}

/** Tells what a Script error means. Returns undefined for an error that the Script itself threw. */
export function explainScriptError(message: string): string | undefined {
  if (message.includes("limit_exceeded: maxToolCalls"))
    return `The Script asked for more than ${String(SCRIPT_LIMITS.maxToolCalls)} Tool calls, the maxToolCalls limit. The Harness refused the next call and ended the Script with this error, also when the Script catches it.`;
  if (message.includes("limit_exceeded: wallMs"))
    return `The Script ran for more than ${String(SCRIPT_LIMITS.wallMs)} ms, the wallMs limit. The Harness stopped it.`;
  if (message.includes("limit_exceeded: cpuMs"))
    return `The Script used more than ${String(SCRIPT_LIMITS.cpuMs)} ms of CPU time, the cpuMs limit. Cloudflare stopped it. Local workerd does not enforce this limit.`;
  if (/tools\.\w+ is not a function/.test(message))
    return "The Script gets only the Tools that the Permission Policy allows. A Tool that needs an Approval is not in tools, because a Script cannot wait for an Approval.";
  if (message.includes("not permitted to access the internet"))
    return "A Script has no network access. The isolate has no outbound connection, thus each fetch fails.";
  return undefined;
}

const callIdOf = (threadId: string, event: ThreadEvent) => `${threadId}:${String(event.seq)}`;

/**
 * Returns each `run_script` call of an event log with its result and its nested Tool calls. A nested call has the
 * `parentCallId` of its Script. A Script without a result when its Turn ends is `stopped`.
 */
export function scriptRuns(threadId: string, events: readonly ThreadEvent[]): ScriptRun[] {
  const runs = new Map<string, ScriptRun>();
  // The id of a call in its Step, mapped to its run. A Provider can use the same id again in a later Step.
  const open = new Map<string, ScriptRun>();
  const nested = new Map<string, NestedCall>();
  for (const event of events) {
    if (event.type === "tool.call" && event.parentCallId) {
      const call = {
        callId: callIdOf(threadId, event),
        parentCallId: event.parentCallId,
        name: event.name,
        input: event.input,
      };
      nested.set(event.id, call);
      runs.get(event.parentCallId)?.calls.push(call);
    } else if (event.type === "tool.result" && event.parentCallId) {
      const call = nested.get(event.id);
      if (call) call.isError = event.isError;
    } else if (event.type === "tool.call" && event.name === "run_script") {
      const input = scriptInputSchema.safeParse(event.input);
      const run: ScriptRun = {
        callId: callIdOf(threadId, event),
        code: input.success ? input.data.code : "",
        state: "running",
        logs: [],
        calls: [],
      };
      runs.set(run.callId, run);
      open.set(event.id, run);
    } else if (event.type === "tool.result" && event.name === "run_script") {
      const run = open.get(event.id);
      if (!run) continue;
      open.delete(event.id);
      Object.assign(run, readResult(event.content, event.isError));
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      for (const run of open.values()) {
        run.state = "stopped";
        run.explanation =
          "The Turn ended before the Script finished. The Script stopped, and it cannot call a Tool any more. A change that a Tool made before stays.";
      }
      open.clear();
    }
  }
  return [...runs.values()];
}

function readResult(content: readonly { type: string; text?: string }[], isError: boolean): Partial<ScriptRun> {
  const text = content.map((block) => block.text ?? "").join("");
  let parsed;
  try {
    parsed = scriptResultSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  // A result that is not the JSON of the Sandbox is an error of the Harness, for example a missing binding.
  if (!parsed?.success) return { state: "failed", error: text };
  const { value, error, logs } = parsed.data;
  if (!isError && !error) return { state: "done", value, logs };
  const message = error?.message ?? text;
  const explanation = explainScriptError(message);
  return { state: "failed", error: message, logs, ...(explanation && { explanation }) };
}
