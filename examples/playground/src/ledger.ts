import { defineAgent, defineTool } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { decodeSample, sampleData, type SampleDataDO } from "./sample-data";

/** The id of the Compaction and recovery scenario. */
export const COMPACTION = "compaction";
/** The id of the Agent of the scenario. */
export const LEDGER = "ledger";

/**
 * The context limits of the Agent. They are small on purpose, thus a short conversation is over the limit and
 * the Harness compacts it. A real Agent inherits the window of its model.
 */
export const CONTEXT = { window: 2000, reserveTokens: 500, keepRecentTokens: 500 };

/** How long a Tool waits for a held ledger at most. */
const HOLD_TIMEOUT_MS = 5 * 60 * 1000;
/** The time between two reads of a held ledger. */
const HOLD_POLL_MS = 500;

/** The schema of the sample ledger system. */
export const ledgerSchema = z.object({
  entries: z.array(z.object({ id: z.string(), text: z.string(), amount: z.number() })),
  /**
   * The number of entries from which the ledger is held. A Tool call on a held ledger waits before it returns its
   * result. Absent while the ledger is open. The operator holds the ledger from its current number of entries.
   * A test holds it from a later number, thus one Step can have a call that finished and a call that waits.
   */
  holdFrom: z.number().optional(),
});

/** The sample ledger system of the scenario. */
export type Ledger = z.infer<typeof ledgerSchema>;

/** True while the ledger is held: it has at least `holdFrom` entries. */
export const isHeld = (ledger: Ledger): boolean =>
  ledger.holdFrom !== undefined && ledger.entries.length >= ledger.holdFrom;

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
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const LEDGER_PROMPTS = [
  { label: "Long conversation", text: "Read the ledger and describe each entry in one sentence." },
  { label: "Safe call", text: "Read the ledger and tell me the total amount." },
  { label: "Unsafe call", text: "Post an entry of 12 for window cleaning, then read the ledger to check it." },
];

/** Decodes the stored sample data. Data that is absent or not valid gives the starting ledger. */
export const decodeLedger = (data: string | undefined): Ledger => decodeSample(ledgerSchema, STARTING_LEDGER, data);

/** A hold request: hold the ledger now, hold it from a number of entries, or release it. */
export type HoldRequest = { held: true; from?: number } | { held: false };

/** Decodes the body of the hold route. A body of a different shape gives undefined. */
export function decodeHold(body: unknown): HoldRequest | undefined {
  if (typeof body !== "object" || body === null || !("held" in body) || typeof body.held !== "boolean")
    return undefined;
  if (!body.held) return { held: false };
  const from = "from" in body ? body.from : undefined;
  if (from === undefined) return { held: true };
  return typeof from === "number" && Number.isInteger(from) && from >= 0 ? { held: true, from } : undefined;
}

/** The sample system that stores the ledger. */
export type LedgerSystem = DurableObjectStub<SampleDataDO>;

const ledgerSystem = (scope: string): LedgerSystem => sampleData(env.PLAYGROUND_DATA, scope, COMPACTION);

/** Reads the ledger of the sample system. */
export const readLedgerOf = async (stub: LedgerSystem): Promise<Ledger> => decodeLedger((await stub.read()).data);

/** Writes the ledger to the sample system. */
export const writeLedger = (stub: LedgerSystem, ledger: Ledger): Promise<void> =>
  stub.write(JSON.stringify(ledger satisfies Ledger));

/**
 * Waits while the ledger is held. The wait ends when the operator releases the ledger, when the Harness aborts
 * the call or after `HOLD_TIMEOUT_MS`.
 */
async function whileHeld(stub: LedgerSystem, signal: AbortSignal): Promise<void> {
  for (let polls = 0; polls < HOLD_TIMEOUT_MS / HOLD_POLL_MS && !signal.aborted; polls += 1) {
    if (!isHeld(await readLedgerOf(stub))) return;
    await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
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
    return JSON.stringify((await readLedgerOf(stub)).entries);
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
    const ledger = await readLedgerOf(stub);
    const id = `E-${String(ledger.entries.length + 1)}`;
    await writeLedger(stub, { ...ledger, entries: [...ledger.entries, { id, text, amount }] });
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
