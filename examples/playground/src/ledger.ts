import { defineAgent, defineTool } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the Compaction and recovery scenario. */
export const COMPACTION = "compaction";
/** The id of the Agent of the scenario. */
export const LEDGER = "ledger";

/**
 * The context limits of the Agent. They are small on purpose, thus a short conversation is over the limit and
 * the Harness compacts it. A real Agent inherits the window of its model.
 */
export const CONTEXT = { window: 2000, reserveTokens: 500, keepRecentTokens: 500 };

/** How long a Tool waits for a held ledger at most, in polls of half a second. */
const HOLD_POLLS = 600;

/** The schema of the sample ledger system. */
export const ledgerSchema = z.object({
  entries: z.array(z.object({ id: z.string(), text: z.string(), amount: z.number() })),
  /** True while the operator holds the ledger. Each Tool call then waits before it returns its result. */
  held: z.boolean(),
});

/** The sample ledger system of the scenario. */
export type Ledger = z.infer<typeof ledgerSchema>;

/** The ledger that the scenario starts with and that a reset restores. */
export const STARTING_LEDGER: Ledger = {
  entries: [
    { id: "E-1", text: "Coffee beans for the shop", amount: 38 },
    { id: "E-2", text: "Paper bags, 500 pieces", amount: 21 },
    { id: "E-3", text: "Repair of the grinder", amount: 65 },
    { id: "E-4", text: "Milk delivery, week 37", amount: 44 },
    { id: "E-5", text: "Window sign", amount: 90 },
    { id: "E-6", text: "Milk delivery, week 38", amount: 46 },
  ],
  held: false,
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const LEDGER_PROMPTS = [
  { label: "Long conversation", text: "Read the ledger and describe each entry in one sentence." },
  { label: "Safe call", text: "Read the ledger and tell me the total amount." },
  { label: "Unsafe call", text: "Post an entry of 12 for window cleaning, then read the ledger to check it." },
];

/** Decodes the stored sample data. Data that is absent or not valid gives the starting ledger. */
export const decodeLedger = (data: string | undefined): Ledger => decodeSample(ledgerSchema, STARTING_LEDGER, data);

/** Decodes the body of the hold route. A body of a different shape gives undefined. */
export function decodeHold(body: unknown): boolean | undefined {
  if (typeof body !== "object" || body === null || !("held" in body)) return undefined;
  return typeof body.held === "boolean" ? body.held : undefined;
}

const ledgerSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, COMPACTION);

/**
 * Waits while the operator holds the ledger. The wait ends when the operator releases the ledger, when the
 * Harness aborts the call or after five minutes.
 */
async function whileHeld(stub: ReturnType<typeof ledgerSystem>, signal: AbortSignal): Promise<void> {
  for (let poll = 0; poll < HOLD_POLLS && !signal.aborted; poll += 1) {
    if (!decodeLedger((await stub.read()).data).held) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Reads the ledger. It has `readOnlyHint`, thus the Harness runs an interrupted call again. */
export const readLedger = defineTool({
  name: "read_ledger",
  description: "Read each entry of the sample ledger",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async execute(_input, { scope, signal }) {
    const stub = ledgerSystem(scope);
    await whileHeld(stub, signal);
    return JSON.stringify(decodeLedger((await stub.read()).data).entries);
  },
});

/**
 * Posts one entry to the ledger. It has no `idempotentHint`, thus an interrupted call gets an error result and
 * does not run again. The Tool writes the entry before it waits for a held ledger. An interruption during the
 * wait then leaves the entry in the ledger, and the model must check before it posts again.
 */
export const postEntry = defineTool({
  name: "post_entry",
  description: "Post one entry to the sample ledger",
  input: z.object({
    text: z.string().describe("What the entry is for"),
    amount: z.number().describe("The amount in whole currency units"),
  }),
  annotations: { destructiveHint: false },
  async execute({ text, amount }, { scope, signal }) {
    const stub = ledgerSystem(scope);
    const ledger = decodeLedger((await stub.read()).data);
    const id = `E-${String(ledger.entries.length + 1)}`;
    await stub.write(
      JSON.stringify({ ...ledger, entries: [...ledger.entries, { id, text, amount }] } satisfies Ledger),
    );
    await whileHeld(stub, signal);
    return `Posted entry ${id}.`;
  },
});

/** Defines the Agent of the scenario for the model that setup selected. */
export const ledgerAgent = (model: string) =>
  defineAgent({
    agentId: LEDGER,
    name: "Ledger clerk",
    instructions: [
      {
        text: "You keep the ledger of a small shop. Use read_ledger to read it and post_entry to add an entry. When a Tool result says that a call was interrupted, read the ledger before you post the same entry again. Answer in a few sentences.",
      },
    ],
    model: { id: model },
    tools: ["read_ledger", "post_entry"],
    context: CONTEXT,
    policy: [{ match: { tool: ["read_ledger", "post_entry"] }, effect: "allow" }],
  });
