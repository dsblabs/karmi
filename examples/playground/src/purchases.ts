import { defineAgent, defineTool } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { errorResult } from "./results";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the Delegation scenario. */
export const DELEGATION = "delegation";
/** The id of the parent Agent of the scenario. */
export const MANAGER = "manager";
/** The id of the child Agent, which the parent delegates to. */
export const BUYER = "buyer";

/** The schema of the sample purchase system. */
export const purchasesSchema = z.object({
  suppliers: z.array(z.object({ id: z.string(), name: z.string(), item: z.string(), unitPrice: z.number() })),
  orders: z.array(z.object({ id: z.string(), supplierId: z.string(), item: z.string(), quantity: z.number() })),
});

/** The sample purchase system of the scenario. */
export type Purchases = z.infer<typeof purchasesSchema>;

/** The purchase system that the scenario starts with and that a reset restores. */
export const STARTING_PURCHASES: Purchases = {
  suppliers: [
    { id: "S-1", name: "Bean & Co", item: "Bag of espresso beans", unitPrice: 14 },
    { id: "S-2", name: "Roast House", item: "Bag of espresso beans", unitPrice: 11 },
    { id: "S-3", name: "Paper Mill", item: "Box of filter paper", unitPrice: 6 },
  ],
  orders: [],
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const PURCHASE_PROMPTS = [
  {
    label: "Delegate",
    text: "Ask the purchase desk to order 20 bags of espresso beans from the cheapest supplier. Then tell me what it did.",
  },
  {
    label: "Two children",
    text: "Give the purchase desk two separate tasks at the same time: order 20 bags of espresso beans from the cheapest supplier, and order 10 boxes of filter paper. Then tell me what it did.",
  },
];

/** Decodes the stored sample data. Data that is absent or not valid gives the starting purchase system. */
export const decodePurchases = (data: string | undefined): Purchases =>
  decodeSample(purchasesSchema, STARTING_PURCHASES, data);

const purchaseSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, DELEGATION);

/** Reads the suppliers. The Policy of the child Agent allows it, because it changes nothing. */
export const listSuppliers = defineTool({
  name: "list_suppliers",
  description: "List each supplier of the sample purchase system with its item and unit price",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async execute(_input, { scope }) {
    return JSON.stringify(decodePurchases((await purchaseSystem(scope).read()).data).suppliers);
  },
});

/** Places an order. No Policy rule matches it, thus each call waits for an Approval, which the parent shows. */
export const placeOrder = defineTool({
  name: "place_order",
  description: "Place an order with a supplier in the sample purchase system",
  input: z.object({
    supplierId: z.string().describe("The supplier id, for example S-2"),
    quantity: z.number().int().positive().describe("How many units to order"),
  }),
  annotations: { destructiveHint: false },
  async execute({ supplierId, quantity }, { scope }) {
    const stub = purchaseSystem(scope);
    const purchases = decodePurchases((await stub.read()).data);
    const supplier = purchases.suppliers.find((item) => item.id === supplierId);
    if (!supplier) return errorResult(`There is no supplier ${supplierId}.`);
    const id = `O-${String(purchases.orders.length + 1)}`;
    const order = { id, supplierId, item: supplier.item, quantity };
    await stub.write(JSON.stringify({ ...purchases, orders: [...purchases.orders, order] } satisfies Purchases));
    return `Placed order ${id}: ${String(quantity)} × ${supplier.item} from ${supplier.name}.`;
  },
});

/**
 * Defines the parent Agent for the model that setup selected. The `delegation` grant gives it the `delegate` Tool
 * of the Framework, and `delegates` names the one Agent that it can give a task to.
 */
export const managerAgent = (model: string) =>
  defineAgent({
    agentId: MANAGER,
    name: "Shop manager",
    instructions: [
      {
        text: "You manage a small shop. You place no order yourself. Use the delegate tool to give each purchase task to the purchase desk, one task per call, and put every detail of the task in the task text. Report its answer to the operator in one or two sentences.",
      },
    ],
    model: { id: model },
    delegates: [BUYER],
    capabilities: { delegation: {} },
    policy: [{ match: { tool: "delegate" }, effect: "allow" }],
  });

/** Defines the child Agent for the model that setup selected. It runs in its own Thread with new context. */
export const buyerAgent = (model: string) =>
  defineAgent({
    agentId: BUYER,
    name: "Purchase desk",
    instructions: [
      {
        text: "You work at the purchase desk of a small shop. List the suppliers before you order. Place the order with place_order. Answer in one sentence that names the order id, or says that no order was placed.",
      },
    ],
    model: { id: model },
    tools: ["list_suppliers", "place_order"],
    // No rule matches `place_order`, thus it waits for an Approval. The parent Thread shows that Approval again.
    policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
  });
