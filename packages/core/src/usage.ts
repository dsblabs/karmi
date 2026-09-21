import { asc, lte } from "drizzle-orm";
import type { ThreadDatabase } from "./db/thread/database";
import { usageOutbox } from "./db/thread/schema";
import type { ParentLink } from "./delegation";
import { KarmiError } from "./errors";
import type { ThreadEvent } from "./thread-events";

/**
 * Who a Usage record is for: the Scope, Agent, User and Thread that spent it, and the delegating Thread
 * when this Thread is a Delegation child. The Turn and `seq` are on the record itself.
 */
export interface UsageAttribution {
  scope: string;
  agent: string;
  user?: string;
  threadId: string;
  /** The delegating Thread and call, when this Thread is a Delegation child. A child records its own spend. */
  parent?: ParentLink;
}

/** One `usage.recorded` event as the Thread logged it and as the `UsageHandler` receives it. */
export type UsageRecord = Extract<ThreadEvent, { type: "usage.recorded" }>;

/**
 * The Catalogue item that receives Usage records. The Queue delivers batches at least once, so `onUsage`
 * deduplicates by `usageKey(record)`. A thrown error retries the batch and never fails the Turn that spent it.
 */
export interface UsageHandler {
  onUsage(records: UsageRecord[]): void | Promise<void>;
}

/** The idempotency key of a Usage record, `threadId:seq`. A record delivered twice has the same key. */
export function usageKey(record: Pick<UsageRecord, "threadId" | "seq">): string {
  return `${record.threadId}:${record.seq}`;
}

/** Validates a UsageHandler definition and returns it frozen. Throws `usage.invalid` without an `onUsage`. */
export function defineUsageHandler(input: UsageHandler): UsageHandler {
  if (typeof input.onUsage !== "function")
    throw new KarmiError("usage.invalid", "A UsageHandler needs an onUsage(records) function.");
  return Object.freeze({ onUsage: input.onUsage });
}

/** The next Usage records to send: their `seq` values in order, and whether more wait after them. */
export interface UsageBatch {
  seqs: number[];
  more: boolean;
}

/**
 * The Outbox of one Thread for Usage records that the Queue has not received. It holds only the `seq` of each
 * record, because the record is in the Thread event log. It never sends a record and never sets an Alarm.
 */
export class UsageOutbox {
  constructor(private db: ThreadDatabase) {}

  /** Adds the record at `seq`. Call it in the same synchronous write as the event, so an eviction never loses it. */
  enqueue(seq: number): void {
    this.db.insert(usageOutbox).values({ seq }).run();
  }

  /** The first `limit` waiting records. */
  batch(limit: number): UsageBatch {
    const rows = this.db
      .select({ seq: usageOutbox.seq })
      .from(usageOutbox)
      .orderBy(asc(usageOutbox.seq))
      .limit(limit + 1)
      .all();
    return { seqs: rows.slice(0, limit).map((row) => row.seq), more: rows.length > limit };
  }

  /** Removes every record up to `seq`, after the Queue accepted them. */
  settle(seq: number): void {
    this.db.delete(usageOutbox).where(lte(usageOutbox.seq, seq)).run();
  }

  /** Removes every waiting record. */
  clear(): void {
    this.db.delete(usageOutbox).run();
  }
}
