import { subscribeSocket } from "./thread-subscription";
import type { ThreadUploads } from "./media";
import type { KarmiBindings } from "./bindings";
import type { ScopeId, UserId } from "./context";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { assertIdentifier } from "./names";
import { remote, type Outcome, unwrap } from "./outcome";
import type { Usage } from "./provider";
import type { ThreadDurableObject } from "./thread-do";
import type { ScheduleSummary } from "./schedule";
import type { ToolContent, ToolResult } from "./tool";
import type { ApprovalAnswer, Budget, Granularity, PauseReason, ThreadEvent, TurnInput } from "./thread-events";

/** The part of a Thread's key the Channel binding chooses: the Agent, the User and the `threadId`. */
export interface ThreadIdentity {
  agent: string;
  /** Absent for a Thread driven only by user-less Events. */
  user?: UserId;
  threadId: string;
}

/** The full address of one Thread Durable Object as the Worker calls it. */
export interface ThreadAddress extends ThreadIdentity {
  scope: ScopeId;
  /** Whether the call may create the Thread. It is false for a handle opened from a key. */
  create: boolean;
}

/** What the running Turn has spent in its current budget window, together with the bounds it runs under. */
export interface ThreadBudget extends Budget {
  /** The Steps, wall time and tokens the Turn may spend before it parks for a `continue` Approval. */
  max: Budget;
  /** Child Threads started during this Turn, in total and still running. Present only under `delegation`. */
  delegated?: { children: number; active: number };
}

/** An unanswered Approval of a parked Turn, as reported by `thread.status()`. */
export interface PendingApproval {
  /** The `seq` of the `approval.requested` event. `thread.approve` takes it. */
  seq: number;
  /** The child Thread that raised the Approval, when a Delegation raised it rather than this Thread. */
  child?: { threadId: string; seq: number };
  kind: "tool" | "continue" | "connect";
  /** The Tool that asked, for a `tool` or `connect` Approval. */
  tool?: string;
  /** The MCP server a `connect` Approval needs a grant for. */
  serverId?: string;
  /** The URL at which the human completes OAuth to answer a `connect` Approval. */
  authUrl?: string;
  /** When an unanswered Approval becomes a deny, as epoch milliseconds. */
  timeoutAt: number;
}

/** A snapshot of one Thread: whether a Turn is running, what it has spent and where the log ends. */
export interface ThreadStatus {
  /** The delegating Thread and call when this Thread is a Delegation child. */
  parent?: import("./delegation").ParentLink;
  state: "idle" | "running" | "parked";
  /** The current Turn while running or parked. */
  turn?: number;
  /** The current Step while running or parked. */
  step?: number;
  /** Why the Turn is parked. */
  paused?: PauseReason;
  /** What the running or parked Turn has spent. */
  budget?: ThreadBudget;
  /** Unanswered Approvals of the parked Turn, oldest first. */
  pendingApprovals?: PendingApproval[];
  /** The Agent Spec version the last Turn ran under. */
  agentVersion?: number;
  /** Token usage summed over every completed model Step of the Thread. */
  usage: Usage;
  /** The last `seq` in the log. `subscribe({ after: seq })` streams only what comes next. */
  seq: number;
  /** When the soonest pending Schedule of this Thread fires. */
  nextScheduleAt?: number;
}

/**
 * The request for a Schedule: the Event to deliver and exactly one timing. `at` and `delay` fire once. `cron` fires
 * repeatedly in the IANA zone `tz`, UTC by default.
 */
export type ScheduleInput = (
  | { at: number | string; delay?: never; cron?: never; tz?: never }
  | { delay: number | string; at?: never; cron?: never; tz?: never }
  | { cron: string; tz?: string; at?: never; delay?: never }
) & { input: Extract<TurnInput, { kind: "event" }> };

/** One Thread as listed by `scope.threads.list()`. */
export interface ThreadSummary extends ThreadIdentity {
  /** The delegating Thread and call when this Thread is a Delegation child. */
  parent?: import("./delegation").ParentLink;
  /** The opaque key `scope.thread(key)` reopens the Thread with. */
  key: string;
  createdAt: number;
  lastActiveAt: number;
  /** The first message's opening words. */
  title?: string;
}

/** Options of `thread.send()`. */
export interface SendOptions {
  /** Inject into the running Turn at its next batch boundary instead of queueing a next Turn. */
  steer?: boolean;
}

/** Options of `thread.compact()`. */
export interface CompactOptions {
  /** Guidance for the summary, handed to the `before-compact` Hooks and the summarising model. */
  instructions?: string;
}

/** How a Job started by a Tool's `{ pending: jobId }` reports back into the Thread. */
export interface ThreadJobs {
  /** Records progress of a running Job as a `job.progress` event. */
  progress(jobId: string, content: string | ToolContent[]): Promise<void>;
  /** Ends the Job with the Tool's result, as if the Tool had returned it. */
  complete(jobId: string, result: ToolResult): Promise<void>;
  /** Ends the Job with an error result carrying `message`. */
  fail(jobId: string, message: string): Promise<void>;
  /** Ends the Job with a cancelled error result. */
  cancel(jobId: string): Promise<void>;
}

/** A handle on one Thread. Every method calls the Thread's Durable Object, which holds all state. */
export interface Thread {
  /** Stores media under this Thread and returns the `MediaRef` a Turn input can carry, or discards one again. */
  readonly uploads: ThreadUploads;
  /** Marks the Thread as deleted immediately. Its storage is removed later in scheduler batches. */
  delete(): Promise<void>;
  /** The opaque, serialisable key of this Thread. `scope.thread(key)` reopens it but never creates it. */
  readonly key: string;
  /** The Agent, User and `threadId` this handle addresses, as decoded from its key. */
  readonly identity: ThreadIdentity;
  /**
   * Accepts the input and returns the Turn it will run in and the log position to subscribe after.
   * Inputs that arrive while a Turn runs or is parked coalesce, in order, into the one next Turn.
   */
  send(input: TurnInput, options?: SendOptions): Promise<{ turn: number; seq: number }>;
  /** Answers the `approval.requested` event at `seq`. A second answer is rejected. */
  approve(seq: number, answer: ApprovalAnswer): Promise<void>;
  /**
   * Ends the running or parked Turn as `turn.failed { reason: "cancelled" }`. Queued inputs still run.
   * A no-op when the Thread is idle.
   */
  cancel(): Promise<void>;
  /** Continues a Turn parked by Scope suspension, under a fresh snapshot of the Scope and Agent Spec. */
  resume(): Promise<void>;
  /** Reports the outcome of Jobs started by this Thread's Tools. */
  readonly jobs: ThreadJobs;
  /**
   * Compacts the context of an idle Thread now. A `before-compact` Hook may still skip it. Rejected while a
   * Turn runs or is parked.
   */
  compact(options?: CompactOptions): Promise<void>;
  /**
   * Creates a new Thread for the same Agent and User whose log is this one's up to `seq`. A `seq` at a Turn
   * boundary gives the fork a complete transcript. The media that log refers to is copied into the fork, so the
   * fork keeps it after this Thread is deleted. Resolves once every copy has landed; if any copy fails it rejects
   * and leaves no fork behind.
   */
  fork(seq: number, target?: { threadId?: string }): Promise<Thread>;
  /**
   * Opens a hibernating client socket, live by default; `after` opts into replay and granularity defaults to delta.
   * Authority is fixed at upgrade, including after credential revocation, until the client disconnects.
   * Close code 4004 is terminal; other closes can reconnect using the last event's seq.
   */
  socket(options?: { after?: number; granularity?: Granularity }): Promise<Response>;
  /** Streams live events until the consumer stops; `after` opts into replay and granularity defaults to delta. */
  subscribe(options?: { after?: number; granularity?: Granularity }): AsyncIterable<ThreadEvent>;
  /** Returns the persisted events after `after`, default the whole log, without waiting for new ones. */
  events(options?: { after?: number }): Promise<ThreadEvent[]>;
  status(): Promise<ThreadStatus>;
  /**
   * Wakes this Thread later with `input` as an ordinary Turn input. A cron keeps at most one undelivered
   * firing. At most 100 pending Schedules per Thread, none further than a year ahead.
   */
  schedule(input: ScheduleInput): Promise<{ scheduleId: string; nextAt: number }>;
  /** Removes a pending Schedule. Rejected with `schedule.notFound` when this Thread has no such Schedule. */
  cancelSchedule(scheduleId: string): Promise<void>;
  /** Pending Schedules, soonest first. */
  schedules(): Promise<ScheduleSummary[]>;
}

const TITLE_LENGTH = 80;

/**
 * Opens a handle on one Thread of `scope`. An identity may create the Thread on first use. A key only reopens
 * an existing one. Throws when the agent or user id is invalid.
 */
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
  // `keys.thread` validates the threadId, so an invalid one never reaches a Durable Object name.
  const stub = remote<ThreadDurableObject>(bindings.KARMI_THREADS, keys.thread(scope, identity.threadId));
  const socket: Thread["socket"] = (options) => openSocket(bindings, address, options);
  return {
    key: encodeKey(identity),
    identity,
    uploads: {
      put: (body, options) => unwrap(stub.upload(address, body, options ?? {})),
      delete: (ref) => unwrap(stub.discardUpload(address, ref)),
    },
    delete: () => unwrap(stub.delete(address)),
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
    schedule: (input) => unwrap(stub.schedule(address, input)),
    cancelSchedule: (scheduleId) => unwrap(stub.cancelSchedule(address, scheduleId)),
    schedules: () => unwrap(stub.schedules(address)),
    socket,
    subscribe: (options) => subscribeSocket(socket, options),
  };
}

async function openSocket(
  bindings: KarmiBindings,
  address: ThreadAddress,
  options: Parameters<Thread["socket"]>[0],
): Promise<Response> {
  const url = new URL("https://thread.internal/socket");
  if (options?.after !== undefined) url.searchParams.set("after", String(options.after));
  const response = await bindings.KARMI_THREADS.getByName(keys.thread(address.scope, address.threadId)).fetch(url, {
    headers: {
      upgrade: "websocket",
      "x-karmi-thread": JSON.stringify({ address, granularity: options?.granularity ?? "delta" }),
    },
  });
  if (response.status !== 101) {
    await unwrap(Promise.resolve(decodeSocketFailure(await response.text())));
  }
  return response;
}

// The internal binding returns core's own error codes; only its failure envelope crosses this boundary.
function decodeSocketFailure(json: string): Outcome<never> {
  const failure: Outcome<never> = JSON.parse(json);
  if (
    typeof failure !== "object" ||
    failure === null ||
    failure.ok !== false ||
    typeof failure.code !== "string" ||
    typeof failure.message !== "string"
  )
    throw new Error("Invalid internal Thread upgrade failure.");
  return failure;
}

/** Encodes a Thread identity as the opaque, URL-safe key `Thread.key` exposes. */
export function encodeKey(identity: ThreadIdentity): string {
  return btoa(JSON.stringify([identity.agent, identity.user ?? null, identity.threadId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decodes a key made by `encodeKey`. Throws `thread.key.invalid` for anything else. */
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

/** Derives a Thread title from a Turn input: the opening words of a message's first text Part, or undefined. */
export function titleOf(input: TurnInput): string | undefined {
  if (input.kind !== "message") return undefined;
  const text = input.parts
    .find((part) => part.type === "text")
    ?.text.trim()
    .replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length <= TITLE_LENGTH ? text : `${text.slice(0, TITLE_LENGTH - 1)}…`;
}
