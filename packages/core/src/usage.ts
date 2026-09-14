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
