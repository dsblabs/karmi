import * as z from "zod/mini";
import type { Capabilities } from "./agent";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import { isTimeZone, nextCronTime, parseCron } from "./cron";
import { milliseconds } from "./duration";
import type { KarmiErrorCode } from "./errors";
import type { Tool, ToolResult } from "./tool";
import type { TurnInput } from "./thread-events";

// Schedules, the pure part: what a request must look like, when it first fires, the caps it runs under,
// and the SQL rows a Thread keeps for them. Firing is the Thread DO's job; nothing here touches a clock.

export type EventInput = Extract<TurnInput, { kind: "event" }>;

/** What a Thread remembers of one Schedule: `once` fires at `at`; `cron` fires at each `nextAt` in `tz`. */
export type ScheduleTiming = { kind: "once"; at: number } | { kind: "cron"; cron: string; tz: string };

export interface ScheduleRecord {
  id: string;
  timing: ScheduleTiming;
  input: EventInput;
  createdAt: number;
  nextAt: number;
  /** The `inputs` row of the last firing; a cron whose row is still queued skips its next tick. */
  pendingInput?: number;
}

/** What `thread.schedules()` and `list_schedules` return. */
export interface ScheduleSummary {
  scheduleId: string;
  at?: number;
  cron?: string;
  tz?: string;
  nextAt: number;
  createdAt: number;
  input: EventInput;
}

/** Nothing on any Thread schedules past these, whoever asks. */
export const SCHEDULE_CAPS = Object.freeze({ maxPending: 100, maxHorizonMs: 366 * 24 * 60 * 60 * 1000 });

export interface SchedulingLimits {
  maxPending: number;
  maxHorizonMs: number;
  cron: boolean;
}

const EventInputSchema = z.object({
  kind: z.literal("event"),
  type: z.string().check(z.minLength(1)),
  payload: z.unknown(),
  channelRef: z.optional(z.unknown()),
});
const timeText = z.string().check(z.minLength(1));
/** The one decode of a Schedule request, whether it arrived over RPC or from the model. */
const ScheduleRequestSchema = z.object({
  at: z.optional(z.union([z.number(), timeText])),
  delay: z.optional(z.union([z.number(), timeText])),
  cron: z.optional(timeText),
  tz: z.optional(timeText),
  input: EventInputSchema,
});
export type ScheduleRequest = z.output<typeof ScheduleRequestSchema>;

export type ScheduleFailure = { code: Extract<KarmiErrorCode, "schedule.invalid" | "schedule.limit">; message: string };
export type Resolved = { ok: true; timing: ScheduleTiming; nextAt: number } | ({ ok: false } & ScheduleFailure);

const invalid = (message: string): Resolved => ({ ok: false, code: "schedule.invalid", message });

/** Normalises a request into its timing and first firing; every rejection is one `schedule.invalid`. */
export function resolveSchedule(request: unknown, now: number): Resolved {
  const parsed = z.safeParse(ScheduleRequestSchema, request);
  if (!parsed.success) return invalid('A Schedule needs `input: { kind: "event", type, payload }`.');
  const { at, delay, cron, tz } = parsed.data;
  const given = [at, delay, cron].filter((value) => value !== undefined).length;
  if (given !== 1) return invalid("Exactly one of `at`, `delay` or `cron` is required.");
  if (cron !== undefined) {
    const zone = tz ?? "UTC";
    if (!isTimeZone(zone)) return invalid(`Unknown time zone "${zone}".`);
    if (!parseCron(cron)) return invalid(`"${cron}" is not a five-field cron expression.`);
    const nextAt = nextCronTime(cron, now, zone);
    if (nextAt === undefined) return invalid(`"${cron}" never fires.`);
    return { ok: true, timing: { kind: "cron", cron, tz: zone }, nextAt };
  }
  if (tz !== undefined) return invalid("`tz` applies to `cron` only; give `at` with an offset instead.");
  let fireAt: number;
  if (delay !== undefined) {
    const ms = milliseconds(delay);
    if (!Number.isFinite(ms) || ms < 0) return invalid(`"${delay}" is not a delay such as 1500 or "24h".`);
    fireAt = now + ms;
  } else {
    fireAt = typeof at === "number" ? at : Date.parse(at ?? "");
    if (!Number.isFinite(fireAt)) return invalid(`"${at}" is not epoch milliseconds or an ISO 8601 date.`);
  }
  return { ok: true, timing: { kind: "once", at: fireAt }, nextAt: fireAt };
}

/** The cap a new Schedule would break, if any: how many are pending and how far ahead it first fires. */
export function overLimit(limits: SchedulingLimits, pending: number, nextAt: number, now: number): string | undefined {
  if (pending >= limits.maxPending) return "maxPending";
  if (nextAt - now > limits.maxHorizonMs) return "maxHorizonMs";
  return undefined;
}

/** Fills in the Framework defaults and applies the Scope ceiling as a maximum; both stay under the Deployment caps. */
export function resolveSchedulingLimits(
  grant: NonNullable<Capabilities["scheduling"]>,
  ceiling: false | NonNullable<Capabilities["scheduling"]> | undefined,
): SchedulingLimits {
  const max = ceiling || {};
  return {
    maxPending: Math.min(
      grant.maxPending ?? AGENT_SPEC_DEFAULTS.scheduling.maxPending,
      max.maxPending ?? SCHEDULE_CAPS.maxPending,
      SCHEDULE_CAPS.maxPending,
    ),
    maxHorizonMs: Math.min(
      grant.maxHorizonMs ?? AGENT_SPEC_DEFAULTS.scheduling.maxHorizonMs,
      max.maxHorizonMs ?? SCHEDULE_CAPS.maxHorizonMs,
      SCHEDULE_CAPS.maxHorizonMs,
    ),
    cron: (grant.cron ?? true) && max.cron !== false,
  };
}

/** The Thread API's limits: the Deployment caps alone. */
export const API_LIMITS: SchedulingLimits = Object.freeze({ ...SCHEDULE_CAPS, cron: true });

/** The one place a Schedule's alarm job is named. */
export const scheduleJobId = (scheduleId: string): string => `schedule:${scheduleId}`;

export function summarise(record: ScheduleRecord): ScheduleSummary {
  return {
    scheduleId: record.id,
    ...(record.timing.kind === "once" ? { at: record.timing.at } : { cron: record.timing.cron, tz: record.timing.tz }),
    nextAt: record.nextAt,
    createdAt: record.createdAt,
    input: record.input,
  };
}

const decodeRecord = (json: string): ScheduleRecord => JSON.parse(json);

/** A Thread's pending Schedules; the row is the truth, the scheduler job merely wakes the DO. */
export class ScheduleStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_next ON schedules (next_at);`);
  }
  get(id: string): ScheduleRecord | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM schedules WHERE id = ?", id).toArray()[0];
    return row && decodeRecord(row.json);
  }
  list(): ScheduleRecord[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM schedules ORDER BY next_at, id")
      .toArray()
      .map((row) => decodeRecord(row.json));
  }
  count(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schedules").one().n;
  }
  nextAt(): number | undefined {
    return this.sql.exec<{ at: number | null }>("SELECT MIN(next_at) AS at FROM schedules").one().at ?? undefined;
  }
  save(record: ScheduleRecord): void {
    this.sql.exec(
      "INSERT INTO schedules (id, next_at, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET next_at = excluded.next_at, json = excluded.json",
      record.id,
      record.nextAt,
      JSON.stringify(record),
    );
  }
  delete(id: string): void {
    this.sql.exec("DELETE FROM schedules WHERE id = ?", id);
  }
}

// The Agent's built-ins under the `scheduling` Capability. They address the Thread they run in and
// nothing else; the host is the Thread DO.
export interface SchedulingHost {
  create(
    request: ScheduleRequest,
    id: string,
  ): { ok: true; summary: ScheduleSummary } | ({ ok: false } & ScheduleFailure);
  cancel(id: string): boolean;
  list(): ScheduleSummary[];
}

const ScheduleToolInput = z.object({
  at: z.optional(z.string()),
  delay: z.optional(z.string()),
  cron: z.optional(z.string()),
  tz: z.optional(z.string()),
  payload: z.optional(z.unknown()),
});
const CancelScheduleInput = z.object({ scheduleId: z.string() });
const ListSchedulesInput = z.object({});

export const SCHEDULE_FIRED = "schedule.fired";

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  isError,
});

export function schedulingTools(host: SchedulingHost): Tool[] {
  const schedule: Tool<typeof ScheduleToolInput, undefined> = {
    kind: "tool",
    name: "schedule",
    description:
      'Wakes you up later on this same conversation with an event of type "schedule.fired" carrying `payload`. Give exactly one of `delay` (such as "10m", "2h", "1d"), `at` (an ISO 8601 date-time with offset) or `cron` (five fields, evaluated in `tz`, default UTC). Returns the scheduleId.',
    input: ScheduleToolInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: ({ payload, ...timing }, ctx) => {
      const created = host.create(
        { ...timing, input: { kind: "event", type: SCHEDULE_FIRED, payload: payload ?? null } },
        ctx.callId,
      );
      return created.ok ? text(created.summary) : text(created.message, true);
    },
  };
  const cancel: Tool<typeof CancelScheduleInput, undefined> = {
    kind: "tool",
    name: "cancel_schedule",
    description: "Cancels one of your pending schedules by its scheduleId.",
    input: CancelScheduleInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: ({ scheduleId }) =>
      host.cancel(scheduleId) ? `Cancelled ${scheduleId}.` : text(`No schedule "${scheduleId}".`, true),
  };
  const list: Tool<typeof ListSchedulesInput, undefined> = {
    kind: "tool",
    name: "list_schedules",
    description: "Lists your pending schedules on this conversation, soonest first.",
    input: ListSchedulesInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: () => text(host.list()),
  };
  return [schedule, cancel, list];
}
