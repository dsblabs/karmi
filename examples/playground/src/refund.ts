import { defineAgent, defineTool, type ToolOutputResult } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { sampleData } from "./sample-data";

/** The id of the refund scenario. It is also the id of its Agent. */
export const REFUND = "refund";

const orderSchema = z.object({
  id: z.string(),
  customer: z.string(),
  item: z.string(),
  total: z.number(),
  status: z.enum(["delivered", "refunded"]),
  refund: z.object({ amount: z.number(), reason: z.string() }).optional(),
});

/** The sample order of the refund scenario. */
export type Order = z.infer<typeof orderSchema>;

/** The order that the scenario starts with and that a reset restores. */
export const STARTING_ORDER: Order = {
  id: "A-1042",
  customer: "Sam Rivera",
  item: "Ceramic pour-over coffee set",
  total: 48,
  status: "delivered",
};

/** The prompt that the scenario suggests. The operator can edit it. */
export const REFUND_PROMPT =
  "The customer of order A-1042 says the coffee set arrived broken. Look up the order and refund the full amount.";

/** Decodes the stored sample data. Data that is absent or not valid gives the starting order. */
export function decodeOrder(data: string | undefined): Order {
  if (data === undefined) return STARTING_ORDER;
  try {
    const parsed = orderSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : STARTING_ORDER;
  } catch {
    return STARTING_ORDER;
  }
}

const errorResult = (text: string): ToolOutputResult => ({ content: [{ type: "text", text }], isError: true });

const orders = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, REFUND);

/** Reads the sample order. The Policy of the Agent allows it, because it changes nothing. */
export const getOrder = defineTool({
  name: "get_order",
  description: "Look up an order in the sample order system",
  input: z.object({ orderId: z.string().describe("The order id, for example A-1042") }),
  annotations: { readOnlyHint: true },
  async execute({ orderId }, { scope }) {
    const order = decodeOrder((await orders(scope).read()).data);
    return order.id === orderId ? JSON.stringify(order) : errorResult(`There is no order ${orderId}.`);
  },
});

/** Refunds the sample order. No Policy rule matches it, thus each call waits for an Approval. */
export const refundOrder = defineTool({
  name: "refund_order",
  description: "Refund an order in the sample order system",
  input: z.object({
    orderId: z.string(),
    amount: z.number().positive().describe("The amount to refund"),
    reason: z.string().describe("Why the customer gets the refund"),
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
  async execute({ orderId, amount, reason }, { scope }) {
    const stub = orders(scope);
    const order = decodeOrder((await stub.read()).data);
    if (order.id !== orderId) return errorResult(`There is no order ${orderId}.`);
    if (order.status === "refunded") return errorResult(`Order ${orderId} already has a refund.`);
    if (amount > order.total) return errorResult(`The refund cannot be more than the order total of ${order.total}.`);
    await stub.write(JSON.stringify({ ...order, status: "refunded", refund: { amount, reason } } satisfies Order));
    return `Refunded ${amount} on order ${orderId}.`;
  },
});

/** Defines the Agent of the refund scenario for the model that setup selected. */
export const refundAgent = (model: string) =>
  defineAgent({
    agentId: REFUND,
    name: "Refund desk",
    instructions: [
      {
        text: "You work at the refund desk of a small shop. Look up the order before you act. Use the tools to make a refund. Answer in one or two sentences.",
      },
    ],
    model: { id: model },
    tools: ["get_order", "refund_order"],
    // Rules are tried in order and the first match decides. No rule matches `refund_order`, so it waits for an Approval.
    policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
  });
