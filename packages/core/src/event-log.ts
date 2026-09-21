import {
  and,
  asc,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  lte,
  max,
  min,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { boundBatches } from "./db/bound-values";
import type { ThreadDatabase } from "./db/thread/database";
import { events } from "./db/thread/schema";
import { excludedEventTypes } from "./thread-sockets";
import type { Granularity, ThreadEvent, ThreadEventData, TurnInput } from "./thread-events";
import type { LoggedEvent } from "./turn-state";
import type { UsageRecord } from "./usage";

// Each seeded row binds one value per column.
const EVENT_COLUMNS = Object.keys(getTableColumns(events)).length;

/** One stored row of the Thread event log, as a Fork copies it. */
export type EventRow = typeof events.$inferSelect;
/** One Thread event of the given type. */
type EventOf<T extends ThreadEventData["type"]> = Extract<ThreadEvent, { type: T }>;

// This is the only decode point for the `json` column. The rows are the Thread's own, so the shape is
// trusted. A shape change handles old rows here.
const decodeEvent = (value: ThreadEventData): ThreadEventData => value;
const toEvent = (row: EventRow): ThreadEvent => ({
  seq: row.seq,
  turn: row.turn,
  at: row.at,
  ...decodeEvent(row.json),
});

/**
 * The append-only Thread event log of one Thread. It is the only code that reads or writes the `events` table.
 * It assigns each `seq`. It never sends an event to a Subscriber, an Outbox or an Alarm. The caller does that
 * with the event that `append` returns.
 */
export class EventLog {
  // The head is read on first use, because the table does not exist until the migrations of the Durable
  // Object have run.
  private last: number | undefined;

  constructor(private db: ThreadDatabase) {}

  /** The `seq` of the last event, or 0 for an empty log. */
  get head(): number {
    this.last ??=
      this.db
        .select({ seq: max(events.seq) })
        .from(events)
        .get()?.seq ?? 0;
    return this.last;
  }

  /** Stores one event at the next `seq` and returns it. A defined `channelRef` becomes part of the event. */
  append(turn: number, data: ThreadEventData, channelRef: unknown, at: number): ThreadEvent {
    const seq = this.head + 1;
    const body = channelRef === undefined ? data : { ...data, channelRef };
    this.db.insert(events).values({ seq, turn, at, type: data.type, json: body }).run();
    this.last = seq;
    return { ...body, seq, turn, at };
  }

  /** Reads at most `limit` events with `after < seq <= through`, without the types that `granularity` omits. */
  read(after: number, granularity: Granularity, limit: number, through = Number.MAX_SAFE_INTEGER): ThreadEvent[] {
    const excluded = excludedEventTypes[granularity];
    const range = and(gt(events.seq, after), lte(events.seq, through));
    return this.db
      .select()
      .from(events)
      .where(excluded.length === 0 ? range : and(range, notInArray(events.type, excluded)))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all()
      .map(toEvent);
  }

  /** The event at `seq`, or undefined when the log has none there. */
  at(seq: number): ThreadEvent | undefined {
    const row = this.db.select().from(events).where(eq(events.seq, seq)).get();
    return row && toEvent(row);
  }

  /** The events of one Turn in `seq` order without `message.delta`, which is the input of `foldTurn`. */
  turnEvents(turn: number): LoggedEvent[] {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.turn, turn), ne(events.type, "message.delta")))
      .orderBy(asc(events.seq))
      .all()
      .map(({ seq, at, json }) => ({ seq, at, event: decodeEvent(json) }));
  }

  /** The Turn input that started `turn`, or undefined when the Turn has no `turn.started`. */
  turnInput(turn: number): TurnInput | undefined {
    const row = this.db
      .select({ json: events.json })
      .from(events)
      .where(and(eq(events.turn, turn), eq(events.type, "turn.started")))
      .get();
    const event = row && decodeEvent(row.json);
    return event?.type === "turn.started" ? event.input : undefined;
  }

  /** The `seq` of the first event of `turn`, or undefined when the Turn has no event. */
  firstSeq(turn: number): number | undefined {
    return (
      this.db
        .select({ seq: min(events.seq) })
        .from(events)
        .where(eq(events.turn, turn))
        .get()?.seq ?? undefined
    );
  }

  /** Every `approval.resolved` event of the Thread, in `seq` order. */
  resolvedApprovals(): EventOf<"approval.resolved">[] {
    return this.ofType("approval.resolved");
  }

  /** The last Compaction's `seq`, 0 without one, and the first `seq` still in the model's context. */
  lastCompaction(): { seq: number; firstKeptSeq: number } {
    const last = this.db
      .select({ seq: events.seq, json: events.json })
      .from(events)
      .where(eq(events.type, "thread.compacted"))
      .orderBy(desc(events.seq))
      .get();
    const compacted = last && decodeEvent(last.json);
    return { seq: last?.seq ?? 0, firstKeptSeq: compacted?.type === "thread.compacted" ? compacted.firstKeptSeq : 1 };
  }

  /** Every Load point from the last Compaction's `firstKeptSeq` on, in `seq` order. */
  loadPoints(): EventOf<"tools.loaded">[] {
    return this.ofType("tools.loaded", this.lastCompaction().firstKeptSeq);
  }

  /** Counts the Provider Tool calls of `turn`, or of the Thread without one. It stops counting at `maximum`. */
  providerToolCalls(maximum: number, turn?: number): number {
    const called = eq(events.type, "server_tool.called");
    const bounded = this.db
      .select({ value: sql<number>`1` })
      .from(events)
      .where(turn === undefined ? called : and(called, eq(events.turn, turn)))
      .limit(maximum)
      .as("bounded_provider_tool_calls");
    return Math.min(maximum, this.db.select({ value: countRows() }).from(bounded).get()?.value ?? 0);
  }

  /** Whether the log has a `job.started` for `jobId`. */
  hasStartedJob(jobId: string): boolean {
    const started = and(eq(events.type, "job.started"), sql`json_extract(${events.json}, '$.jobId') = ${jobId}`);
    return this.db.select({ seq: events.seq }).from(events).where(started).get() !== undefined;
  }

  /** The first `tool.result` for `call` after it in its Turn, or undefined while the call has no result. */
  toolResult(call: EventOf<"tool.call">): EventOf<"tool.result"> | undefined {
    const row = this.db
      .select()
      .from(events)
      .where(
        and(
          gt(events.seq, call.seq),
          eq(events.turn, call.turn),
          eq(events.type, "tool.result"),
          sql`json_extract(${events.json}, '$.id') = ${call.id}`,
        ),
      )
      .orderBy(asc(events.seq))
      .get();
    const event = row && toEvent(row);
    return event?.type === "tool.result" ? event : undefined;
  }

  /** The Usage records at `seqs`, in `seq` order. A `seq` that holds no Usage record gives nothing. */
  usageRecords(seqs: readonly number[]): UsageRecord[] {
    const rows = boundBatches(seqs.toSorted((a, b) => a - b)).flatMap((batch) =>
      this.db.select().from(events).where(inArray(events.seq, batch)).orderBy(asc(events.seq)).all(),
    );
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const event = toEvent(row);
      if (event.type === "usage.recorded") records.push(event);
    }
    return records;
  }

  /** The stored rows up to `seq`, in order. A Fork seeds its own log with them. */
  copyThrough(seq: number): EventRow[] {
    return this.db.select().from(events).where(lte(events.seq, seq)).orderBy(asc(events.seq)).all();
  }

  /** Takes `rows` as the whole log of a new Fork. Call it only on an empty log. */
  seed(rows: readonly EventRow[]): void {
    for (const batch of boundBatches(rows, EVENT_COLUMNS)) this.db.insert(events).values(batch).run();
    this.last = rows.at(-1)?.seq ?? 0;
  }

  /** Deletes every event. */
  clear(): void {
    this.db.delete(events).run();
    this.last = 0;
  }

  private ofType<T extends ThreadEventData["type"]>(type: T, fromSeq = 1): EventOf<T>[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.type, type), gte(events.seq, fromSeq)))
      .orderBy(asc(events.seq))
      .all();
    const isType = (event: ThreadEvent): event is EventOf<T> => event.type === type;
    return rows.map(toEvent).filter(isType);
  }
}
