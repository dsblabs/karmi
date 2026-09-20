import { defineAgent, defineHook, defineSkill, defineTool } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { errorResult } from "./results";
import { sampleData } from "./sample-data";

/** The id of the Tools scenario. It is also the id of its Agent. */
export const STOCKROOM = "stockroom";

/** The schema of the sample stock system. */
export const stockSchema = z.object({
  products: z.array(z.object({ sku: z.string(), name: z.string(), stock: z.number() })),
  /** The supplier orders that the `restock` Skill made. */
  supplierOrders: z.array(z.object({ sku: z.string(), quantity: z.number() })),
  /** One line for each finished Tool call. The `stock_audit` Hook writes it. */
  audit: z.array(z.string()),
});

/** The sample stock system of the Tools scenario. */
export type Stock = z.infer<typeof stockSchema>;

/** The stock that the scenario starts with and that a reset restores. */
export const STARTING_STOCK: Stock = {
  products: [
    { sku: "MUG-01", name: "Stoneware mug", stock: 12 },
    { sku: "KET-02", name: "Gooseneck kettle", stock: 0 },
  ],
  supplierOrders: [],
  audit: [],
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const STOCKROOM_PROMPTS = [
  { label: "Deferred Tool", text: "We sold 2 stoneware mugs (MUG-01). Change the stock." },
  { label: "Input that is not valid", text: "Add 5000 units to MUG-01 in one call." },
  { label: "Skill", text: "The gooseneck kettle (KET-02) is out of stock. Restock it." },
  { label: "Policy deny", text: "Delete the product KET-02 from the stock system." },
];

/** Decodes the stored sample data. Data that is absent or not valid gives the starting stock. */
export function decodeStock(data: string | undefined): Stock {
  if (data === undefined) return STARTING_STOCK;
  try {
    const parsed = stockSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : STARTING_STOCK;
  } catch {
    return STARTING_STOCK;
  }
}

const stockSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, STOCKROOM);
const readStock = async (scope: string) => decodeStock((await stockSystem(scope).read()).data);

// A change is one read and one write. The scenario runs one Tool call at a time, so no change is lost.
async function change(scope: string, update: (stock: Stock) => Stock): Promise<void> {
  const stub = stockSystem(scope);
  await stub.write(JSON.stringify(update(await readStock(scope))));
}

const sku = z.string().describe("The product code, for example MUG-01");

/** Reads the stock of one product. The Agent Spec sets `alwaysLoad`, thus the definition never defers. */
export const checkStock = defineTool({
  name: "check_stock",
  description: "Read the stock of one product in the sample stock system",
  input: z.object({ sku }),
  annotations: { readOnlyHint: true },
  async execute(input, { scope }) {
    const product = (await readStock(scope)).products.find((item) => item.sku === input.sku);
    if (!product) return errorResult(`There is no product ${input.sku}.`);
    // The model reads the text. A program reads `structuredContent`.
    return {
      content: [{ type: "text", text: `${product.name}: ${product.stock} in stock.` }],
      structuredContent: product,
    };
  },
});

/** Changes the stock of one product. The definition defers, thus the model loads it with `tool_search`. */
export const adjustStock = defineTool({
  name: "adjust_stock",
  description: "Add units to the stock of one product, or remove units from it",
  // The Harness refuses a call that does not match this schema, and `execute` does not run.
  input: z.object({ sku, change: z.number().int().min(-100).max(100).describe("Units to add. Negative removes.") }),
  annotations: { destructiveHint: false },
  async execute(input, { scope }) {
    const stock = await readStock(scope);
    const product = stock.products.find((item) => item.sku === input.sku);
    if (!product) return errorResult(`There is no product ${input.sku}.`);
    const next = product.stock + input.change;
    if (next < 0) return errorResult(`${input.sku} has only ${product.stock} units.`);
    // The write uses the state that the checks read, thus a stale value cannot go in with a fresh one.
    await stockSystem(scope).write(
      JSON.stringify({
        ...stock,
        products: stock.products.map((item) => (item.sku === input.sku ? { ...item, stock: next } : item)),
      } satisfies Stock),
    );
    return {
      content: [{ type: "text", text: `${input.sku} now has ${next} units.` }],
      structuredContent: { sku: input.sku, stock: next },
    };
  },
});

/** Deletes one product. The Permission Policy of the Agent denies it, thus `execute` never runs. */
export const deleteProduct = defineTool({
  name: "delete_product",
  description: "Delete one product from the sample stock system",
  input: z.object({ sku }),
  annotations: { destructiveHint: true },
  async execute(input, { scope }) {
    await change(scope, (now) => ({ ...now, products: now.products.filter((item) => item.sku !== input.sku) }));
    return `Deleted ${input.sku}.`;
  },
});

const orderSupplier = defineTool({
  name: "order_supplier",
  description: "Order units of one product from the supplier",
  input: z.object({ sku, quantity: z.number().int().positive().max(100) }),
  annotations: { destructiveHint: false },
  async execute(input, { scope }) {
    await change(scope, (now) => ({ ...now, supplierOrders: [...now.supplierOrders, input] }));
    return `Ordered ${input.quantity} units of ${input.sku} from the supplier.`;
  },
});

/** The procedure for a product that is out of stock. Its body and its Tool exist only after activation. */
export const restock = defineSkill({
  name: "restock",
  description: "How to restock a product that is out of stock",
  body: () =>
    "Check the stock first. Order from the supplier only when the stock is 0. Order 24 units, which is one full box.",
  tools: [orderSupplier],
});

/** Writes one line to the audit log of the sample system after each Tool call. */
export const stockAudit = defineHook({
  name: "stock_audit",
  point: "after-tool",
  description: "Writes each finished Tool call to the audit log of the sample stock system",
  async run({ scope, call, result }) {
    const line = `${call.name} ${JSON.stringify(call.input)}: ${result.isError ? "error" : "ok"}`;
    await change(scope, (now) => ({ ...now, audit: [...now.audit, line] }));
  },
});

/** Defines the Agent of the Tools scenario for the model that setup selected. */
export const stockroomAgent = (model: string) =>
  defineAgent({
    agentId: STOCKROOM,
    name: "Stockroom",
    instructions: [
      {
        text: "You keep the stock system of a small shop. Use the tools for each change. Answer in one or two sentences.",
      },
    ],
    model: { id: model },
    tools: [{ name: "check_stock", alwaysLoad: true }, "adjust_stock", "delete_product"],
    skills: ["restock"],
    hooks: { "after-tool": ["stock_audit"] },
    // `always` defers each Tool that has no `alwaysLoad`, also when the definitions are small.
    context: { tools: { defer: "always" } },
    // Rules are tried in order and the first match decides. One rule matches an annotation, the others match names.
    policy: [
      { match: { tool: ["delete_product"] }, effect: "deny" },
      { match: { annotations: { readOnlyHint: true } }, effect: "allow" },
      {
        match: { tool: ["adjust_stock", "order_supplier", "tool_search", "use_skill"] },
        effect: "allow",
      },
    ],
  });
