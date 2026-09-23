import {
  consoleLogger,
  defineAgent,
  defineTool,
  defineUsageHandler,
  redactFields,
  usageKey,
  type Logger,
  type Thread,
  type UsageRecord,
} from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { routeError } from "./route-error";
import { decodeSample, sampleData, type SampleDataDO } from "./sample-data";

/** The id of the Usage and logging scenario. It is also the id of its Agent. */
export const OBSERVABILITY = "observability";

/** The fields that the lookup Tool logs. The Logger redacts the credential names before it stores the line. */
export const SAMPLE_LOG_FIELDS = {
  ticketId: "T-9",
  apiKey: "sk-live-example",
  authorization: "Bearer secret-token",
  note: "Opened the ticket.",
};

/** The fields the sample UsageHandler stores for one record. */
export const storedUsageSchema = z.object({
  threadId: z.string(),
  seq: z.number(),
  scope: z.string(),
  agent: z.string(),
  user: z.string().optional(),
});

/**
 * One delivery of a Usage record to the sample UsageHandler. `stored` is the first delivery of its key, `duplicate`
 * is a later one that the handler skips, and `failed` is a delivery that threw, thus the Queue delivers it again.
 */
export const deliverySchema = z.object({
  key: z.string(),
  status: z.enum(["failed", "stored", "duplicate"]),
  record: storedUsageSchema,
});

type Delivery = z.infer<typeof deliverySchema>;

/** The inspection data of the scenario. Reset restores the starting value. */
export const inspectionSchema = z.object({
  failNext: z.boolean().default(false),
  deliveries: z.array(deliverySchema).default([]),
});

/** The stored sample data of the scenario, including logs and the last delivered batch. */
export const observabilityDataSchema = inspectionSchema.extend({
  logs: z
    .array(
      z.object({
        level: z.string(),
        message: z.string(),
        fields: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
  lastRecords: z.array(storedUsageSchema).optional(),
  redaction: z
    .object({ before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) })
    .optional(),
});

/** The stored sample data of the Usage and logging scenario. */
export type ObservabilityData = z.infer<typeof observabilityDataSchema>;

/** The starting inspection data. Reset restores it. */
export const STARTING_INSPECTION: z.infer<typeof inspectionSchema> = { failNext: false, deliveries: [] };

const startingData: ObservabilityData = { ...STARTING_INSPECTION, logs: [] };

// The page shows the last deliveries and log lines only, thus the stored lists stay small.
const KEEP = 50;

/** Decodes the stored sample data. Data that is absent or not valid gives the starting inspection data. */
export const decodeObservability = (data: string | undefined): ObservabilityData =>
  decodeSample(observabilityDataSchema, startingData, data);

/**
 * An example Usage record of a Delegation child. The page shows its `parent` field. The scenario does not
 * start a child Thread.
 */
export const EXAMPLE_CHILD_RECORD = {
  type: "usage.recorded" as const,
  kind: "model",
  scope: "sample-a",
  agent: "buyer",
  user: "operator",
  threadId: "manager-0/c1",
  seq: 4,
  turn: 1,
  parent: { threadKey: "sample-a:manager-0", callId: "manager-0:1:c1" },
  model: "fake/model",
  provider: "fake",
  profile: "default",
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const OBSERVABILITY_PROMPTS = [
  { label: "Ask the desk", text: "What can the Usage desk do for me? Answer in one sentence." },
  { label: "Look up a ticket", text: "Look up ticket T-9. Tell me its status in one sentence." },
];

const store = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, OBSERVABILITY);

type StoredUsage = z.infer<typeof storedUsageSchema>;

function stamp(record: UsageRecord): StoredUsage {
  return {
    threadId: record.threadId,
    seq: record.seq,
    scope: record.scope,
    agent: record.agent,
    ...(record.user && { user: record.user }),
  };
}

/**
 * Stores one delivery of each record. A key that the handler stored before is a duplicate. A real handler makes
 * this check in the same write as the record, for example with a unique index on the key.
 */
async function deliver(
  stub: DurableObjectStub<SampleDataDO>,
  data: ObservabilityData,
  records: StoredUsage[],
  failed: boolean,
): Promise<void> {
  const stored = new Set(data.deliveries.filter((item) => item.status === "stored").map((item) => item.key));
  for (const record of records) {
    const key = usageKey(record);
    const status = failed ? "failed" : stored.has(key) ? "duplicate" : "stored";
    if (status === "stored") stored.add(key);
    await stub.push("deliveries", JSON.stringify({ key, status, record } satisfies Delivery), KEEP);
  }
}

/**
 * The sample UsageHandler of the Playground. It stores deliveries of this scenario. A thrown error retries the
 * batch. A second delivery of the same `threadId:seq` is a duplicate, and the handler skips it.
 */
export const sampleUsageHandler = defineUsageHandler({
  async onUsage(records) {
    const mine = records.filter((record) => record.agent === OBSERVABILITY).map(stamp);
    const first = mine[0];
    if (!first) return;
    const stub = store(first.scope);
    const data = decodeObservability((await stub.read()).data);
    if (data.failNext) {
      await stub.set("failNext", "false");
      await deliver(stub, data, mine, true);
      throw new Error("The sample UsageHandler failed this batch.");
    }
    await deliver(stub, data, mine, false);
    await stub.set("lastRecords", JSON.stringify(mine));
  },
});

/**
 * The Deployment Logger of the Playground. It writes JSON lines to the Worker console and stores redacted
 * lines of this scenario for the page.
 */
export function playgroundLogger(): Logger {
  const base = consoleLogger();
  const forward =
    (level: keyof Logger) =>
    (message: string, fields?: Record<string, unknown>): void => {
      base[level](message, fields);
      const scope = fields?.scope;
      if (fields?.agent === OBSERVABILITY && typeof scope === "string")
        void store(scope).push("logs", JSON.stringify({ level, message, fields }), KEEP);
    };
  return {
    debug: forward("debug"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
  };
}

/** Looks up a sample ticket and logs a credential-shaped field for the redaction demo. */
export const lookupTicket = defineTool({
  name: "lookup_ticket",
  description: "Look up a sample support ticket",
  input: z.object({ ticketId: z.string().describe("The ticket id, for example T-9") }),
  annotations: { readOnlyHint: true },
  execute({ ticketId }, { logger }) {
    logger.info("Looked up a ticket", { ...SAMPLE_LOG_FIELDS, ticketId });
    return ticketId === "T-9"
      ? "Ticket T-9 is open. The customer asked about order A-1042."
      : `There is no ticket ${ticketId}.`;
  },
});

/** Defines the Agent of the Usage and logging scenario for the model that setup selected. */
export const observabilityAgent = (model: string) =>
  defineAgent({
    agentId: OBSERVABILITY,
    name: "Usage desk",
    instructions: [
      {
        text: "You work at the Usage desk of a small shop. When asked about a ticket, look it up with the tool. Answer in one or two sentences. Do not invent a cost.",
      },
    ],
    model: { id: model },
    tools: ["lookup_ticket"],
    policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
  });

/**
 * Tells whether the Queue has not yet delivered the last Usage record to the sample UsageHandler. The Queue
 * delivers after the Turn, thus the page reads the state again while this is true.
 */
export function awaitsDelivery(usage: readonly UsageRecord[], deliveries: readonly Delivery[]): boolean {
  const last = usage.at(-1);
  if (!last) return false;
  const key = usageKey(last);
  return !deliveries.some((item) => item.key === key && item.status !== "failed");
}

/** Sets the sample UsageHandler to fail the next batch of this scenario. */
export async function failNextDelivery(stub: DurableObjectStub<SampleDataDO>): Promise<void> {
  await stub.set("failNext", "true");
}

/**
 * Keeps only the deliveries, log lines and last batch of the Thread `threadId`. The Queue can deliver a batch of
 * the Thread before a reset after the reset, and the page must not show it.
 */
export function currentThread(data: ObservabilityData, threadId: string): ObservabilityData {
  const { lastRecords, ...rest } = data;
  const last = lastRecords?.filter((record) => record.threadId === threadId);
  return {
    ...rest,
    deliveries: data.deliveries.filter((item) => item.record.threadId === threadId),
    logs: data.logs.filter((line) => line.fields.thread === threadId),
    ...(last && last.length > 0 && { lastRecords: last }),
  };
}

/** Delivers the last stored batch of the current Thread again, so the page can show a duplicate. */
export async function replayLastBatch(
  stub: DurableObjectStub<SampleDataDO>,
  open: (generation: number) => Thread,
): Promise<Response | undefined> {
  const stored = await stub.read();
  const data = currentThread(decodeObservability(stored.data), open(stored.generation).identity.threadId);
  const records = data.lastRecords ?? [];
  if (records.length === 0)
    return routeError(409, "playground.noUsageBatch", "No UsageHandler batch is stored yet. Run a prompt first.");
  await deliver(stub, data, records, false);
  return undefined;
}

/** Stores the redacted copy of the sample log fields for the page. */
export async function storeRedaction(stub: DurableObjectStub<SampleDataDO>): Promise<void> {
  await stub.set("redaction", JSON.stringify({ before: SAMPLE_LOG_FIELDS, after: redactFields(SAMPLE_LOG_FIELDS) }));
}
