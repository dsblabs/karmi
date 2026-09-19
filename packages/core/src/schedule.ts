import * as z from "zod/mini";
import type { Capabilities } from "./agent";
import { isTimeZone, nextCronTime, parseCron } from "./cron";
import { milliseconds } from "./duration";
import type { KarmiErrorCode } from "./errors";
import type { Tool, ToolResult } from "./tool";
import type { TurnInput } from "./thread-events";

// The pure part of Schedules. It defines what a request must look like, when it first fires, the caps
// it runs under, and the SQL rows a Thread keeps for them. Firing belongs to the Thread Durable Object,
// and nothing here reads a clock.

/** A Turn input of kind `event`, which is the only input a Schedule can deliver. */
export type EventInput = Extract<TurnInput, { kind: "event" }>;

/**
 * When a Schedule fires. A `once` timing fires at `at`. A `cron` timing fires at each `nextAt`, evaluated in
 * `tz`.
 */
export type ScheduleTiming = { kind: "once"; at: number } | { kind: "cron"; cron: string; tz: string };

/** What a Thread stores for one Schedule. */
export interface ScheduleRecord {
  id: string;
  timing: ScheduleTiming;
  /** The Event delivered at each firing. */
  input: EventInput;
  createdAt: number;
  /** The next firing, as epoch milliseconds. */
  nextAt: number;
  /** The `inputs` row of the last firing. A cron whose row is still queued skips its next tick. */
  pendingInput?: number;
}

/** One Schedule as `thread.schedules()` and `list_schedules` report it. */
export interface ScheduleSummary {
  scheduleId: string;
  /** The firing time of a one-shot Schedule, as epoch milliseconds. */
  at?: number;
  /** The expression of a recurring Schedule. */
  cron?: string;
  /** The IANA zone a `cron` is evaluated in. */
  tz?: string;
  nextAt: number;
  createdAt: number;
  input: EventInput;
}

/** The Deployment caps on Schedules. No Thread schedules beyond them, whichever API creates the Schedule. */
export const SCHEDULE_CAPS = Object.freeze({ maxPending: 100, maxHorizonMs: 366 * 24 * 60 * 60 * 1000 });

/** The resolved bounds one caller may schedule within. */
export interface SchedulingLimits {
  /** How many Schedules may be pending on the Thread at once. */
  maxPending: number;
  /** How far ahead a first firing may lie, in milliseconds. */
  maxHorizonMs: number;
  /** Whether recurring Schedules are allowed. */
  cron: boolean;
}

const EventInputSchema = z.object({
  kind: z.literal("event"),
  type: z.string().check(z.minLength(1)),
  payload: z.unknown(),
  channelRef: z.optional(z.unknown()),
});
const timeText = z.string().check(z.minLength(1));
/** The single decoder of a Schedule request, whether it arrived over RPC or from the model. */
const ScheduleRequestSchema = z.object({
  at: z.optional(z.union([z.number(), timeText])),
  delay: z.optional(z.union([z.number(), timeText])),
  cron: z.optional(timeText),
  tz: z.optional(timeText),
  input: EventInputSchema,
});
/** A request to create a Schedule, as `thread.schedule()` and the `schedule` Tool accept it. */
export type ScheduleRequest = z.output<typeof ScheduleRequestSchema>;

/** Why a Schedule was not created: the request was invalid, or it broke a limit. */
export type ScheduleFailure = { code: Extract<KarmiErrorCode, "schedule.invalid" | "schedule.limit">; message: string };
/** A decoded request with its timing and first firing, or the failure that rejected it. */
export type ScheduleResolution =
  { ok: true; timing: ScheduleTiming; nextAt: number; request: ScheduleRequest } | ({ ok: false } & ScheduleFailure);

const invalid = (message: string): ScheduleResolution => ({ ok: false, code: "schedule.invalid", message });

/**
 * Decodes a request into its timing and first firing after `now`. Every rejection is a `schedule.invalid`
 * failure.
 */
export function resolveSchedule(raw: unknown, now: number): ScheduleResolution {
  const parsed = z.safeParse(ScheduleRequestSchema, raw);
  if (!parsed.success) return invalid('A Schedule needs `input: { kind: "event", type, payload }`.');
  const request = parsed.data;
  const { at, delay, cron, tz } = request;
  const given = [at, delay, cron].filter((value) => value !== undefined).length;
  if (given !== 1) return invalid("Exactly one of `at`, `delay` or `cron` is required.");
  if (cron !== undefined) {
    const zone = tz ?? "UTC";
    if (!isTimeZone(zone)) return invalid(`Unknown time zone "${zone}".`);
    if (!parseCron(cron)) return invalid(`"${cron}" is not a five-field cron expression.`);
    const nextAt = nextCronTime(cron, now, zone);
    if (nextAt === undefined) return invalid(`"${cron}" never fires.`);
    return { ok: true, timing: { kind: "cron", cron, tz: zone }, nextAt, request };
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
  return { ok: true, timing: { kind: "once", at: fireAt }, nextAt: fireAt, request };
}

/** The name of one bound in `SchedulingLimits`. */
export type ScheduleLimit = keyof SchedulingLimits;

/**
 * The limit a new Schedule would break, or undefined when it fits. `pending` counts the Thread's
 * existing Schedules.
 */
export function overLimit(
  limits: SchedulingLimits,
  timing: ScheduleTiming,
  pending: number,
  nextAt: number,
  now: number,
): ScheduleLimit | undefined {
  if (timing.kind === "cron" && !limits.cron) return "cron";
  if (pending >= limits.maxPending) return "maxPending";
  if (nextAt - now > limits.maxHorizonMs) return "maxHorizonMs";
  return undefined;
}

/**
 * The limits an Agent's `scheduling` grant resolves to. Each bound is the grant's value capped by the
 * Scope ceiling and the Deployment cap. A bound the grant leaves unset takes the cap.
 */
export function resolveSchedulingLimits(
  grant: NonNullable<Capabilities["scheduling"]>,
  ceiling: false | NonNullable<Capabilities["scheduling"]> | undefined,
): SchedulingLimits {
  const max = ceiling || {};
  return {
    maxPending: Math.min(grant.maxPending ?? Infinity, max.maxPending ?? Infinity, SCHEDULE_CAPS.maxPending),
    maxHorizonMs: Math.min(grant.maxHorizonMs ?? Infinity, max.maxHorizonMs ?? Infinity, SCHEDULE_CAPS.maxHorizonMs),
    cron: (grant.cron ?? true) && max.cron !== false,
  };
}

/** The limits the Thread API schedules under, which are the Deployment caps alone. */
export const API_LIMITS: SchedulingLimits = Object.freeze({ ...SCHEDULE_CAPS, cron: true });

/** The id of the Alarm that fires the Schedule `scheduleId`. */
export const scheduleAlarmId = (scheduleId: string): string => `schedule:${scheduleId}`;

/** The `ScheduleSummary` of a stored record. */
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

/**
 * The pending Schedules of one Thread, stored in its SQLite. The stored row decides what fires. The
 * Alarm only wakes the Durable Object at `nextAt`.
 */
export class ScheduleStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_next ON schedules (next_at);`);
  }
  /** The record with `id`, or undefined when there is none. */
  get(id: string): ScheduleRecord | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM schedules WHERE id = ?", id).toArray()[0];
    return row && decodeRecord(row.json);
  }
  /** Every pending record, soonest first. */
  list(): ScheduleRecord[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM schedules ORDER BY next_at, id")
      .toArray()
      .map((row) => decodeRecord(row.json));
  }
  count(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schedules").one().n;
  }
  /** The soonest `nextAt` of any pending record, or undefined when none is pending. */
  nextAt(): number | undefined {
    return this.sql.exec<{ at: number | null }>("SELECT MIN(next_at) AS at FROM schedules").one().at ?? undefined;
  }
  /** Inserts the record, or replaces the one with the same id. */
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

/**
 * What the Agent's scheduling Tools call into. The Thread Durable Object implements it for the Thread
 * the Tools run in, and the Tools can reach no other Thread.
 */
export interface SchedulingHost {
  /** Creates a Schedule under the id the caller chose, or reports why it could not. */
  create(
    request: ScheduleRequest,
    id: string,
  ): { ok: true; summary: ScheduleSummary } | ({ ok: false } & ScheduleFailure);
  /** Cancels the Schedule `id`. Returns false when there is none. */
  cancel(id: string): boolean;
  /** Every pending Schedule, soonest first. */
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

/** The Event type of a firing created by the `schedule` Tool. */
export const SCHEDULE_FIRED = "schedule.fired";

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  isError,
});

/**
 * The `schedule`, `cancel_schedule` and `list_schedules` Tools an Agent holds under the `scheduling`
 * Capability.
 */
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
