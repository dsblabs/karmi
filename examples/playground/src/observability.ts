import {
  consoleLogger,
  defineAgent,
  defineTool,
  defineUsageHandler,
  redactFields,
  usageKey,
  type Logger,
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

/** One delivery of a Usage record to the sample UsageHandler. */
export const deliverySchema = z.object({
  key: z.string(),
  status: z.enum(["failed", "accepted"]),
  duplicate: z.boolean(),
  record: z.object({
    threadId: z.string(),
    seq: z.number(),
    scope: z.string(),
    agent: z.string(),
    user: z.string().optional(),
  }),
});

/** The fields the sample UsageHandler stores for one record. */
export const storedUsageSchema = z.object({
  threadId: z.string(),
  seq: z.number(),
  scope: z.string(),
  agent: z.string(),
  user: z.string().optional(),
});

/** The inspection data of the scenario. Reset restores the starting value. */
export const inspectionSchema = z.object({
  failNext: z.boolean(),
  deliveries: z.array(deliverySchema),
});

/** The stored sample data of the scenario, including logs and the last delivered batch. */
export const observabilityDataSchema = inspectionSchema.extend({
  logs: z.array(
    z.object({
      level: z.string(),
      message: z.string(),
      fields: z.record(z.string(), z.unknown()),
    }),
  ),
  lastRecords: z.array(storedUsageSchema).optional(),
  redaction: z
    .object({ before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) })
    .optional(),
});

/** The stored sample data of the Usage and logging scenario. */
export type ObservabilityData = z.infer<typeof observabilityDataSchema>;

/** The starting inspection data. Reset restores it. */
export const STARTING_INSPECTION = { failNext: false, deliveries: [] as z.infer<typeof deliverySchema>[] };

const startingData: ObservabilityData = { ...STARTING_INSPECTION, logs: [] };

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
  { label: "Spend", text: "What is the spend of this Thread so far?" },
  { label: "Look up a ticket", text: "Look up ticket T-9. Tell me its status in one sentence." },
];

const store = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, OBSERVABILITY);

async function update(scope: string, mutate: (data: ObservabilityData) => ObservabilityData): Promise<void> {
  const stub = store(scope);
  const data = decodeObservability((await stub.read()).data);
  await stub.write(JSON.stringify(mutate(data)));
}

function stamp(record: UsageRecord) {
  return {
    threadId: record.threadId,
    seq: record.seq,
    scope: record.scope,
    agent: record.agent,
    ...(record.user && { user: record.user }),
  };
}

type StoredUsage = z.infer<typeof storedUsageSchema>;

async function ingest(records: StoredUsage[], status: "failed" | "accepted"): Promise<void> {
  const first = records[0];
  if (!first) return;
  await update(first.scope, (data) => {
    if (status === "failed") {
      return {
        ...data,
        failNext: false,
        deliveries: [
          ...data.deliveries,
          ...records.map((record) => ({
            key: usageKey(record),
            status,
            duplicate: false,
            record,
          })),
        ],
      };
    }
    const seen = new Set(data.deliveries.filter((item) => item.status === "accepted").map((item) => item.key));
    return {
      ...data,
      lastRecords: records,
      deliveries: [
        ...data.deliveries,
        ...records.map((record) => {
          const key = usageKey(record);
          return { key, status, duplicate: seen.has(key), record };
        }),
      ],
    };
  });
}

/**
 * The sample UsageHandler of the Playground. It stores deliveries of this scenario. A thrown error retries the
 * batch. A second delivery of the same `threadId:seq` is a duplicate.
 */
export const sampleUsageHandler = defineUsageHandler({
  async onUsage(records) {
    const mine = records.filter((record) => record.agent === OBSERVABILITY).map(stamp);
    const first = mine[0];
    if (!first) return;
    const data = decodeObservability((await store(first.scope).read()).data);
    if (data.failNext) {
      await ingest(mine, "failed");
      throw new Error("The sample UsageHandler failed this batch.");
    }
    await ingest(mine, "accepted");
  },
});

async function appendLog(level: string, message: string, fields: Record<string, unknown>): Promise<void> {
  const scope = fields.scope;
  if (typeof scope !== "string") return;
  await update(scope, (data) => ({ ...data, logs: [...data.logs, { level, message, fields }] }));
}

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
      if (fields?.agent === OBSERVABILITY) void appendLog(level, message, fields);
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

/** Sets the sample UsageHandler to fail the next batch of this scenario. */
export async function failNextDelivery(stub: DurableObjectStub<SampleDataDO>): Promise<void> {
  const data = decodeObservability((await stub.read()).data);
  await stub.write(JSON.stringify({ ...data, failNext: true } satisfies ObservabilityData));
}

/** Delivers the last accepted batch again, so the page can show a duplicate. */
export async function replayLastBatch(stub: DurableObjectStub<SampleDataDO>): Promise<Response | undefined> {
  const data = decodeObservability((await stub.read()).data);
  const records = data.lastRecords ?? [];
  if (records.length === 0)
    return routeError(409, "playground.noUsageBatch", "No UsageHandler batch is stored yet. Run a prompt first.");
  await ingest(records, "accepted");
  return undefined;
}

/** Stores the redacted copy of the sample log fields for the page. */
export async function storeRedaction(stub: DurableObjectStub<SampleDataDO>): Promise<void> {
  const data = decodeObservability((await stub.read()).data);
  await stub.write(
    JSON.stringify({
      ...data,
      redaction: { before: SAMPLE_LOG_FIELDS, after: redactFields(SAMPLE_LOG_FIELDS) },
    } satisfies ObservabilityData),
  );
}
