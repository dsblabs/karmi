import type { KarmiBindings } from "./bindings";
import type { ScopeId, UserId } from "./context";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { assertIdentifier } from "./names";
import { remote, type Remote, unwrap } from "./outcome";
import type { Usage } from "./provider";
import type { ThreadDurableObject } from "./thread-do";
import type { ToolContent, ToolResult } from "./tool";
import type { ApprovalAnswer, Budget, Granularity, PauseReason, ThreadEvent, TurnInput } from "./thread-events";

/** What a Channel binding chooses: the Agent, the User (absent for user-less Events) and its own threadId. */
export interface ThreadIdentity {
  agent: string;
  user?: UserId;
  threadId: string;
}

/** How the Worker addresses one Thread Durable Object; `create` is false for a handle opened from a key. */
export interface ThreadAddress extends ThreadIdentity {
  scope: ScopeId;
  create: boolean;
}

/** What the running Turn has spent in its current budget window, against the bounds it runs under. */
export interface ThreadBudget extends Budget {
  max: Budget;
}

export interface PendingApproval {
  /** What `thread.approve` takes. */
  seq: number;
  kind: "tool" | "continue";
  tool?: string;
  timeoutAt: number;
}

export interface ThreadStatus {
  state: "idle" | "running" | "parked";
  /** The current Turn and Step while running or parked. */
  turn?: number;
  step?: number;
  /** Why the Turn is parked. */
  paused?: PauseReason;
  budget?: ThreadBudget;
  /** Unanswered Approvals of the parked Turn, oldest first. */
  pendingApprovals?: PendingApproval[];
  /** The Agent Spec version the last Turn ran under. */
  agentVersion?: number;
  /** Summed over every completed model Step; the Usage-record ticket replaces this placeholder. */
  usage: Usage;
  /** The last `seq` in the log; `subscribe({ after: seq })` streams only what comes next. */
  seq: number;
}

export interface ThreadSummary extends ThreadIdentity {
  key: string;
  createdAt: number;
  lastActiveAt: number;
  /** The first message's opening words. */
  title?: string;
}

export interface SendOptions {
  /** Inject into the running Turn at its next batch boundary instead of queueing a next Turn. */
  steer?: boolean;
}

export interface CompactOptions {
  /** Guidance for the summary, handed to the `before-compact` Hooks and the summarising model. */
  instructions?: string;
}

/** How a Job started by a Tool's `{ pending: jobId }` reports back into the Thread. */
export interface ThreadJobs {
  progress(jobId: string, content: string | ToolContent[]): Promise<void>;
  /** The Tool's result, as if the Tool had returned it. */
  complete(jobId: string, result: ToolResult): Promise<void>;
  fail(jobId: string, message: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

export interface Thread {
  /** Opaque and serialisable; `scope.thread(key)` reopens this Thread but never creates it. */
  readonly key: string;
  /**
   * Accepts the input and returns the Turn it will run in and the log position to subscribe after.
   * Inputs that arrive while a Turn runs or is parked coalesce, in order, into the one next Turn.
   */
  send(input: TurnInput, options?: SendOptions): Promise<{ turn: number; seq: number }>;
  /** Answers the `approval.requested` event at `seq`; a second answer is rejected. */
  approve(seq: number, answer: ApprovalAnswer): Promise<void>;
  /** Ends the running or parked Turn as `turn.failed { reason: "cancelled" }`; queued inputs still run. A no-op when idle. */
  cancel(): Promise<void>;
  /** Continues a Turn parked by Scope suspension, under a fresh snapshot of the Scope and Agent Spec. */
  resume(): Promise<void>;
  readonly jobs: ThreadJobs;
  /** Compacts the context of an idle Thread now; a `before-compact` Hook may still skip it. Rejected while a Turn runs or is parked. */
  compact(options?: CompactOptions): Promise<void>;
  /**
   * A new Thread for the same Agent and User whose log is this one's up to `seq` (a Turn boundary
   * keeps it clean). Media stays with this Thread; the fork reads it by reference.
   */
  fork(seq: number, target?: { threadId?: string }): Promise<Thread>;
  /** Replays from `after` (exclusive, default the whole log), then streams live until the consumer stops. */
  subscribe(options?: { after?: number; granularity?: Granularity }): AsyncIterable<ThreadEvent>;
  events(options?: { after?: number }): Promise<ThreadEvent[]>;
  status(): Promise<ThreadStatus>;
}

const TITLE_LENGTH = 80;

export function openThread(bindings: KarmiBindings, scope: ScopeId, target: ThreadIdentity | string): Thread {
  const identity = typeof target === "string" ? decodeKey(target) : target;
  assertIdentifier("agent.id.invalid", "agent", identity.agent);
  if (identity.user !== undefined) assertIdentifier("user.id.invalid", "user", identity.user);
  const address: ThreadAddress = {
    scope,
    agent: identity.agent,
    threadId: identity.threadId,
    create: typeof target !== "string",
  };
  if (identity.user !== undefined) address.user = identity.user;
  // keys.thread validates the threadId; an invalid one never reaches a Durable Object name.
  const stub = remote<ThreadDurableObject>(bindings.KARMI_THREADS, keys.thread(scope, identity.threadId));
  return {
    key: encodeKey(identity),
    send: (input, options) => unwrap(stub.send(address, input, options?.steer === true)),
    approve: (seq, answer) => unwrap(stub.approve(address, seq, answer)),
    cancel: () => unwrap(stub.cancel(address)),
    resume: () => unwrap(stub.resume(address)),
    jobs: {
      progress: (jobId, content) =>
        unwrap(
          stub.job(address, {
            type: "job.progress",
            jobId,
            content: typeof content === "string" ? [{ type: "text", text: content }] : content,
          }),
        ),
      complete: (jobId, result) => unwrap(stub.job(address, { type: "job.completed", jobId, result })),
      fail: (jobId, message) => unwrap(stub.job(address, { type: "job.failed", jobId, message })),
      cancel: (jobId) => unwrap(stub.job(address, { type: "job.cancelled", jobId })),
    },
    compact: (options) => unwrap(stub.compact(address, options ?? {})),
    fork: async (seq, target) => {
      const forked: ThreadIdentity = { ...identity, threadId: target?.threadId ?? crypto.randomUUID() };
      await unwrap(stub.fork(address, seq, { ...address, threadId: forked.threadId, create: true }));
      return openThread(bindings, scope, forked);
    },
    events: (options) => unwrap(stub.events(address, options?.after ?? 0)),
    status: () => unwrap(stub.status(address)),
    subscribe: (options) => subscribe(stub, address, options?.after ?? 0, options?.granularity ?? "delta"),
  };
}

// Each poll returns as soon as the Thread has something new (or times out empty), so a subscriber never spins.
async function* subscribe(
  stub: Remote<ThreadDurableObject>,
  address: ThreadAddress,
  after: number,
  granularity: Granularity,
): AsyncGenerator<ThreadEvent> {
  for (;;) {
    const batch = await unwrap(stub.poll(address, after, granularity));
    for (const event of batch) {
      after = event.seq;
      if (event.type === "turn.completed" || event.type === "approval.requested")
        await unwrap(stub.consumed(address, event.seq));
      yield event;
    }
  }
}

export function encodeKey(identity: ThreadIdentity): string {
  return btoa(JSON.stringify([identity.agent, identity.user ?? null, identity.threadId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeKey(key: string): ThreadIdentity {
  try {
    const parts: unknown = JSON.parse(atob(key.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Array.isArray(parts)) throw new Error();
    const [agent, user, threadId]: unknown[] = parts;
    if (typeof agent !== "string" || typeof threadId !== "string" || (user !== null && typeof user !== "string"))
      throw new Error();
    return user === null ? { agent, threadId } : { agent, user, threadId };
  } catch {
    throw new KarmiError("thread.key.invalid", "Not a Thread key.");
  }
}

export function titleOf(input: TurnInput): string | undefined {
  if (input.kind !== "message") return undefined;
  const text = input.parts
    .find((part) => part.type === "text")
    ?.text.trim()
    .replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length <= TITLE_LENGTH ? text : `${text.slice(0, TITLE_LENGTH - 1)}…`;
}
