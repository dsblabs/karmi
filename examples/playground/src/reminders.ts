import { defineAgent, defineDeliverer, defineTool, type ThreadEvent, type TurnInput } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the Schedules and offline delivery scenario. */
export const SCHEDULES = "schedules";
/** The id of the Agent of the scenario. */
export const REMINDERS = "reminders";
/** The name of the Deliverer that writes to the sample inbox. */
export const SAMPLE_INBOX = "sample_inbox";
/** The id of the sample system that holds the sample inbox. The Deliverer is its only writer. */
export const INBOX_DATA = `${SCHEDULES}-inbox`;

/** The most pending Schedules that the Agent can hold on its Thread. The Schedules of the operator count too. */
export const MAX_PENDING = 5;

/** The schema of the sample reminder system. */
export const remindersSchema = z.object({
  sent: z.array(z.object({ customer: z.string(), text: z.string() })),
});

/** The sample reminder system of the scenario. */
export type Reminders = z.infer<typeof remindersSchema>;

/** The reminder system that the scenario starts with and that a reset restores. */
export const STARTING_REMINDERS: Reminders = { sent: [] };

/** Decodes the stored sample data. Data that is absent or not valid gives the starting reminder system. */
export const decodeReminders = (data: string | undefined): Reminders =>
  decodeSample(remindersSchema, STARTING_REMINDERS, data);

/** The schema of one message in the sample inbox. */
export const inboxEntrySchema = z.object({
  /** The Thread key and the event `seq`, which identify one delivered event. */
  id: z.string(),
  threadKey: z.string(),
  seq: z.number(),
  kind: z.enum(["approval", "completed", "failed"]),
  text: z.string(),
  /** The Tool call that waits for an Approval. */
  call: z.object({ tool: z.string(), input: z.unknown() }).optional(),
});

/** One message in the sample inbox. */
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

/** Decodes the stored sample inbox. Data that is absent or not valid gives an empty inbox. */
export const decodeInbox = (data: string | undefined): InboxEntry[] =>
  decodeSample(z.array(inboxEntrySchema), [], data);

/** The prompts that the scenario suggests. The operator can edit each one. */
export const REMINDER_PROMPTS = [
  {
    label: "Agent Schedule",
    text: "In 1 minute, remind Sam Rivera that order A-1042 is ready for collection. Use a Schedule.",
  },
  { label: "List", text: "List your pending Schedules." },
  { label: "Agent cancel", text: "Cancel each of your pending Schedules." },
  { label: "Approval", text: "Send a reminder to Sam Rivera now: order A-1042 is ready for collection." },
];

/** The timing modes that the page offers, each with the value that the page suggests. */
export const TIMING_MODES = [
  {
    mode: "delay",
    label: "Delayed",
    value: "1m",
    expect: "Create the Schedule and wait for the delay. The Schedule fires one time, then the Thread deletes it.",
  },
  {
    mode: "at",
    label: "Timed",
    value: "",
    expect:
      "Give a time as ISO 8601 text. The Schedule fires one time at that time. A time in the past fires immediately.",
  },
  {
    mode: "cron",
    label: "Recurring",
    value: "* * * * *",
    expect:
      "The Schedule fires on each cron tick in UTC, thus each minute here. Each tick calls the model. Cancel it or reset the scenario when you are done.",
  },
] as const;

/** A timing mode of a Schedule. */
export type TimingMode = (typeof TIMING_MODES)[number]["mode"];

/** The timing of a new Schedule as the page sends it. */
export interface TimingRequest {
  mode: TimingMode;
  value: string;
}

/** Decodes the body of the Schedule route. A body of a different shape gives undefined. */
export function decodeTiming(body: unknown): TimingRequest | undefined {
  if (typeof body !== "object" || body === null || !("mode" in body) || !("value" in body)) return undefined;
  const { mode, value } = body;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return mode === "delay" || mode === "at" || mode === "cron" ? { mode, value: value.trim() } : undefined;
}

/** Decodes the body of the cancel route. A body of a different shape gives undefined. */
export function decodeScheduleId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("scheduleId" in body)) return undefined;
  return typeof body.scheduleId === "string" && body.scheduleId !== "" ? body.scheduleId : undefined;
}

/** A Turn input that is an Event. */
export type EventInput = Extract<TurnInput, { kind: "event" }>;

/** The `channelRef` that sends the offline output of a Thread in `scope` to the sample inbox. */
export const inboxChannel = (scope: string) => ({ deliverer: { name: SAMPLE_INBOX, ref: { scope } } });

/** The Event that a Schedule of the operator sends when it fires. */
export const reminderDue = (scope: string, mode: TimingMode): EventInput => ({
  kind: "event",
  type: "reminder.due",
  payload: { schedule: mode, customer: "Sam Rivera", note: "Order A-1042 is ready for collection." },
  channelRef: inboxChannel(scope),
});

/** The Event that the external trigger sends. `source` names the system that sent it. */
export const supplierDelivery = (scope: string, source: string, at: number): EventInput => ({
  kind: "event",
  type: "supplier.delivery",
  payload: { source, at: new Date(at).toISOString(), note: "The supplier delivered 24 kettles." },
  channelRef: inboxChannel(scope),
});

const reminderSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, SCHEDULES);

/** Sends a reminder in the sample reminder system. No Policy rule matches it, thus each call waits for an Approval. */
export const sendReminder = defineTool({
  name: "send_reminder",
  description: "Send a reminder to a customer through the sample reminder system",
  input: z.object({
    customer: z.string().describe("The name of the customer"),
    text: z.string().describe("The text of the reminder"),
  }),
  annotations: { destructiveHint: false, openWorldHint: true },
  async execute({ customer, text }, { scope }) {
    const stub = reminderSystem(scope);
    const reminders = decodeReminders((await stub.read()).data);
    await stub.write(JSON.stringify({ sent: [...reminders.sent, { customer, text }] } satisfies Reminders));
    return `Sent the reminder to ${customer}.`;
  },
});

const textOf = (event: Extract<ThreadEvent, { type: "turn.completed" }>) =>
  event.message
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();

/** Returns the inbox messages for delivered events: one for each Tool Approval request and each end of a Turn. */
export function inboxEntries(threadKey: string, events: readonly ThreadEvent[]): InboxEntry[] {
  return events.flatMap((event): InboxEntry[] => {
    const entry = { id: `${threadKey}:${String(event.seq)}`, threadKey, seq: event.seq };
    if (event.type === "approval.requested" && event.kind === "tool")
      return [
        {
          ...entry,
          kind: "approval",
          text: `The Agent wants to call ${event.tool}.`,
          call: { tool: event.tool, input: event.input },
        },
      ];
    if (event.type === "turn.completed")
      return [{ ...entry, kind: "completed", text: textOf(event) || "The Turn completed without text." }];
    if (event.type === "turn.failed") return [{ ...entry, kind: "failed", text: event.message }];
    return [];
  });
}

// The only place that reads the `ref` of a delivery. The scenario binds `{ scope }` on each input.
function decodeRef(ref: unknown): string {
  if (typeof ref === "object" && ref !== null && "scope" in ref && typeof ref.scope === "string") return ref.scope;
  throw new Error("The sample inbox needs a ref with the Scope id.");
}

/**
 * Writes the offline output of a Thread to the sample inbox. Delivery is at-least-once, thus the inbox ignores an
 * event that it has already.
 */
export const sampleInbox = defineDeliverer({
  name: SAMPLE_INBOX,
  granularity: "part",
  async deliver(threadKey, events, ref) {
    const inbox = sampleData(env.PLAYGROUND_DATA, decodeRef(ref), INBOX_DATA);
    for (const entry of inboxEntries(threadKey, events)) await inbox.append(entry.id, JSON.stringify(entry));
  },
});

/** Defines the Agent of the scenario for the model that setup selected. */
export const remindersAgent = (model: string) =>
  defineAgent({
    agentId: REMINDERS,
    name: "Reminder desk",
    instructions: [
      {
        text: "You work at the reminder desk of a small shop. When the operator asks for a reminder at a later time, make a Schedule with the schedule Tool and put the customer and the note in its payload. When an event tells you that a reminder is due, send it with send_reminder. When a supplier event arrives, tell in one sentence what arrived. Answer in one or two sentences.",
      },
    ],
    model: { id: model },
    tools: ["send_reminder"],
    // The grant gives the Agent the built-in Tools `schedule`, `cancel_schedule` and `list_schedules`.
    capabilities: { scheduling: { maxPending: MAX_PENDING } },
    // No rule matches `send_reminder`, so it waits for an Approval.
    policy: [{ match: { tool: ["schedule", "cancel_schedule", "list_schedules"] }, effect: "allow" }],
  });
