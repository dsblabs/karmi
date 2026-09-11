import { AGENT_SPEC_DEFAULTS } from "./agent-spec.js";
import type { AgentSpec, Capabilities, PolicyRule } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import { readOutputTool } from "./builtins.js";
import {
  attachmentsOf,
  chooseCut,
  contextTokens,
  estimateTokens,
  overLimit,
  resolveWindow,
  SUMMARY_SYSTEM,
  summaryInstruction,
  type ContextLimits,
} from "./compaction.js";
import type { Logger } from "./context.js";
import { deliveryBinding, type DeliveryBinding } from "./deliverer.js";
import type { Deployment } from "./deployment.js";
import { errorMessage, KarmiError } from "./errors.js";
import type { Compacted, HookContextBase, HookContexts, HookResults, TurnEnd } from "./hook.js";
import { hooksAt } from "./hooks.js";
import { keys } from "./keys.js";
import { consoleLogger } from "./logger.js";
import { fail, ok, remote, type Outcome } from "./outcome.js";
import { isPlatformFailure } from "./platform-failure.js";
import { evaluatePrompt } from "./prompt.js";
import type { ContentBlock, ProviderError, ProviderEvent, ProviderRequest, StopReason, Usage } from "./provider.js";
import { prepareMessages } from "./replay.js";
import { ScheduledDurableObject, type ScheduledJob } from "./scheduler.js";
import { providerHosts, scopedFetch } from "./scoped-fetch.js";
import type { ScopeConfigDurableObject } from "./scope-config-do.js";
import type { Ceilings, ProviderConfig } from "./scope-config.js";
import type {
  ApprovalAnswer,
  ApprovalSource,
  Budget,
  CompactionTrigger,
  Granularity,
  PauseReason,
  ResumeReason,
  ThreadEvent,
  ThreadEventData,
  ThreadEventType,
  TurnInput,
} from "./thread-events.js";
import {
  encodeKey,
  titleOf,
  type CompactOptions,
  type PendingApproval,
  type ThreadAddress,
  type ThreadStatus,
} from "./thread.js";
import { runToolStep, type PriorCalls, type ToolCall } from "./tool-step.js";
import { foldTurn, type Plan, type Request, type TurnState } from "./turn-state.js";
import { resolveTools, toolDefinitions, type AvailableTool } from "./tools.js";
import { splitModelId, transcriptFromEvents } from "./transcript.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread (scope_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, attempt INTEGER NOT NULL, recoveries INTEGER NOT NULL, agent_version INTEGER, snapshot_json TEXT, usage_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_turn_seq ON events (turn, seq);
  CREATE TABLE IF NOT EXISTS delivery_route (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deliveries (to_seq INTEGER PRIMARY KEY, from_seq INTEGER NOT NULL, turn INTEGER NOT NULL, binding_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS deliveries_turn ON deliveries (turn, to_seq);
  CREATE TABLE IF NOT EXISTS inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL, json TEXT NOT NULL);
`;

/** Eager snapshot ceiling; a larger one is a Spec problem, not something to page lazily. */
export const SNAPSHOT_LIMIT = 256 * 1024;
const MAX_STEP_ATTEMPTS = 3;
const POLL_TIMEOUT_MS = 15_000;
const POLL_LIMIT = 256;
/** A Step past this without progress is presumed lost; the alarm re-enters the loop. */
const STEP_WATCHDOG_MS = 60_000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What a Turn may spend before asking to continue, when the Agent has no `longRunning` grant. */
export const DEFAULT_BUDGET: Readonly<Budget> = Object.freeze({ steps: 25, wallMs: 10 * 60_000, tokens: 500_000 });
/** A granted `longRunning` bound the Spec leaves out; JSON has no Infinity. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const CANCELLED = Symbol("cancelled");

/** What a Turn runs under, persisted locally at its first Step so a Spec change lands on the next Turn. */
export interface TurnSnapshot {
  agentVersion: number;
  /** Stored normalized; a JSON round trip already dropped every explicit `undefined`. */
  spec: AgentSpec;
  /** The chosen Provider profile, secret-free. */
  profile: ProviderConfig;
  /** Scope rules, then Deployment rules, then the Spec's own. */
  policy: PolicyRule[];
  /** The Spec's `approvals.timeout` under the Scope ceiling, in milliseconds. */
  approvalTimeout: number;
  /** The `longRunning` grant under the Scope ceiling, or the small defaults without one. */
  budget: Budget;
  /** The Spec's `context` with the Framework defaults filled in; `window` stays open for the model's own. */
  context: { window?: number; windowCeiling?: number; reserveTokens: number; keepRecentTokens: number };
}

type ThreadRow = {
  scope_id: string;
  agent_id: string;
  user_id: string | null;
  thread_id: string;
  created_at: number;
  state: ThreadStatus["state"];
  turn: number;
  step: number;
  attempt: number;
  recoveries: number;
  platform_failure: number;
  cancelled: number;
  agent_version: number | null;
  snapshot_json: string | null;
  usage_json: string;
};

type EventRow = { seq: number; turn: number; at: number; type: ThreadEventType; json: string };

/** A model Step outcome: the Provider finished, or it failed and the next fallback should try. */
type StepResult = { ok: true; stopReason: StopReason; message: ContentBlock[] } | { ok: false; error: ProviderError };

/** An `approval.requested` before its `timeoutAt` is stamped; distributive so each kind keeps its own fields. */
type ApprovalRequest =
  Extract<ThreadEventData, { type: "approval.requested" }> extends infer E
    ? E extends { timeoutAt: number }
      ? Omit<E, "timeoutAt">
      : never
    : never;

type ModelPlan = Extract<Plan, { kind: "model" }>;
type ToolPlan = Extract<Plan, { kind: "tool" }>;
/** How a compact Step ended: with a `thread.compacted`, called off (nothing to drop or a Hook's `skip`), or failed. */
type CompactResult = { status: "compacted" | "skipped" } | { status: "failed"; message: string };
type Summary = Pick<Compacted, "strategy" | "summary" | "raw" | "usage">;
/** Whether the Turn loop goes on after a helper, or the helper already ended or parked the Turn. */
type Next = "continue" | "stop";

// The one decode point for each JSON column this Durable Object writes. The rows are its own, so the
// shapes are trusted; a shape change handles old rows here.
const decodeUsage = (json: string): Usage => JSON.parse(json);
// Snapshots taken before Compaction landed carry no `context`; they run under the defaults.
const decodeSnapshot = (json: string): TurnSnapshot => ({
  context: { ...AGENT_SPEC_DEFAULTS.context },
  ...JSON.parse(json),
});
const decodeBinding = (json: string): DeliveryBinding => JSON.parse(json);
const decodeEvent = (json: string): ThreadEventData => JSON.parse(json);
const decodeInput = (json: string): TurnInput => JSON.parse(json);

export abstract class ThreadDurableObject extends ScheduledDurableObject {
  abstract readonly deployment: Deployment;

  private head = 0;
  private active = false;
  /** Subscribers parked on an empty poll; each append wakes them all. */
  private waiters: (() => void)[] = [];
  /** Root of the Turn's AbortSignal tree; aborted when the Turn ends or is cancelled. */
  private turnAbort = new AbortController();

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    const columns = (table: string) =>
      new Set(
        ctx.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .map((column) => column.name),
      );
    if (!columns("thread").has("platform_failure")) {
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN platform_failure INTEGER NOT NULL DEFAULT 0");
      // Preserve the raw watchdog installed by versions predating the jobs table.
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO jobs (id, kind, dueAt, payload, attempt, generation) SELECT 'watchdog', 'watchdog', 0, 'null', 0, ? FROM thread WHERE state = 'running'",
        crypto.randomUUID(),
      );
    }
    if (!columns("thread").has("cancelled"))
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0");
    if (!columns("inputs").has("steer"))
      ctx.storage.sql.exec("ALTER TABLE inputs ADD COLUMN steer INTEGER NOT NULL DEFAULT 0");
    this.head = ctx.storage.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").one().seq ?? 0;
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Every entry point: an explicit key creates the Thread on first touch, a bare key never does, and a
  // Thread answers only to the identity it was created with.
  private enter(address: ThreadAddress): Outcome<ThreadRow> {
    let row = this.sql.exec<ThreadRow>("SELECT * FROM thread").toArray()[0];
    if (!row) {
      if (!address.create)
        return fail(new KarmiError("thread.notFound", `Thread "${address.threadId}" does not exist.`));
      row = {
        scope_id: address.scope,
        agent_id: address.agent,
        user_id: address.user ?? null,
        thread_id: address.threadId,
        created_at: this.deployment.clock.now(),
        state: "idle",
        turn: 0,
        step: 0,
        attempt: 0,
        recoveries: 0,
        platform_failure: 0,
        cancelled: 0,
        agent_version: null,
        snapshot_json: null,
        usage_json: JSON.stringify(ZERO_USAGE),
      };
      this.sql.exec(
        "INSERT INTO thread (scope_id, agent_id, user_id, thread_id, created_at, state, turn, step, attempt, recoveries, agent_version, snapshot_json, usage_json) VALUES (?, ?, ?, ?, ?, 'idle', 0, 0, 0, 0, NULL, NULL, ?)",
        row.scope_id,
        row.agent_id,
        row.user_id,
        row.thread_id,
        row.created_at,
        row.usage_json,
      );
    } else if (row.scope_id !== address.scope || row.thread_id !== address.threadId) {
      throw new Error(
        `Thread "${row.scope_id}/${row.thread_id}" was addressed as "${address.scope}/${address.threadId}".`,
      );
    } else if (row.agent_id !== address.agent || row.user_id !== (address.user ?? null)) {
      return fail(
        new KarmiError(
          "thread.mismatch",
          `Thread "${address.threadId}" belongs to Agent "${row.agent_id}"${row.user_id === null ? "" : ` and User "${row.user_id}"`}.`,
        ),
      );
    }
    return ok(row);
  }

  send(address: ThreadAddress, input: TurnInput, steer = false): Outcome<{ turn: number; seq: number }> {
    let binding: DeliveryBinding | undefined;
    try {
      binding = deliveryBinding(input.channelRef);
      if (binding && !this.deployment.catalogue.deliverers.has(binding.name))
        throw new KarmiError("deliverer.notFound", `Unknown Deliverer "${binding.name}".`);
      if (binding && !this.env.KARMI_QUEUE)
        throw new KarmiError("bindings.missing", "Offline delivery requires KARMI_QUEUE.");
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (binding)
      this.sql.exec(
        "INSERT INTO delivery_route (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
        JSON.stringify(binding),
      );
    // A steer joins the Turn in flight; anything else coalesces into the one next Turn.
    const joins = steer && row.state !== "idle";
    this.sql.exec(
      "INSERT INTO inputs (turn, json, steer) VALUES (?, ?, ?)",
      joins ? row.turn : row.turn + 1,
      JSON.stringify(input),
      joins ? 1 : 0,
    );
    if (this.active) this.armWatchdog();
    else if (row.state === "idle" || row.state === "running") this.kick(row.state === "running");
    else if (!joins && this.readTurn(row).paused === "scope_suspended") this.wake(row, "input");
    return ok({ turn: joins ? row.turn : row.turn + 1, seq: this.head });
  }

  events(address: ThreadAddress, after: number): Outcome<ThreadEvent[]> {
    const row = this.enter(address);
    if (!row.ok) return row;
    return ok(this.read(after, "delta", Number.MAX_SAFE_INTEGER));
  }

  status(address: ThreadAddress): Outcome<ThreadStatus> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    const status: ThreadStatus = {
      state: row.state,
      ...(row.agent_version !== null && { agentVersion: row.agent_version }),
      usage: decodeUsage(row.usage_json),
      seq: this.head,
    };
    if (row.state === "idle") return ok(status);
    const turn = this.readTurn(row);
    status.turn = row.turn;
    status.step = row.step;
    if (turn.paused) status.paused = turn.paused;
    if (row.snapshot_json !== null) status.budget = { ...turn.budget, max: decodeSnapshot(row.snapshot_json).budget };
    const pending: PendingApproval[] = [];
    for (const [seq, request] of turn.requests)
      if (!request.answered)
        pending.push({
          seq,
          kind: request.kind,
          ...(request.kind === "tool" && { tool: request.tool }),
          timeoutAt: request.timeoutAt,
        });
    if (pending.length > 0) status.pendingApprovals = pending;
    return ok(status);
  }

  /** Returns the next events after `after`, waiting for the first one when the log has nothing yet. */
  async poll(address: ThreadAddress, after: number, granularity: Granularity): Promise<Outcome<ThreadEvent[]>> {
    const row = this.enter(address);
    if (!row.ok) return row;
    if (after > this.head)
      return fail(
        new KarmiError("thread.seq.invalid", `The log ends at seq ${this.head}; cannot subscribe after ${after}.`),
      );
    if (after === this.head) await this.nextAppend();
    return ok(this.read(after, granularity, POLL_LIMIT));
  }

  consumed(address: ThreadAddress, seq: number): Outcome<void> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    this.sql.exec("UPDATE deliveries SET consumed = 1 WHERE to_seq = ?", seq);
    return ok(undefined);
  }

  delivery(
    address: ThreadAddress,
    fromSeq: number,
    toSeq: number,
  ): Outcome<{ binding: DeliveryBinding; events: ThreadEvent[] } | null> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const delivery = this.sql
      .exec<{ binding_json: string }>(
        "SELECT binding_json FROM deliveries WHERE from_seq = ? AND to_seq = ? AND consumed = 0",
        fromSeq,
        toSeq,
      )
      .toArray()[0];
    if (!delivery) return ok(null);
    const binding = decodeBinding(delivery.binding_json);
    const deliverer = this.deployment.catalogue.deliverers.get(binding.name);
    if (!deliverer) return fail(new KarmiError("deliverer.notFound", `Unknown Deliverer "${binding.name}".`));
    const events = this.read(fromSeq - 1, deliverer.granularity ?? "part", toSeq - fromSeq + 1, toSeq);
    return ok({ binding, events });
  }

  async approve(address: ThreadAddress, seq: number, answer: ApprovalAnswer): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    const requested = this.sql
      .exec<{ turn: number }>("SELECT turn FROM events WHERE seq = ? AND type = 'approval.requested'", seq)
      .toArray()[0];
    if (!requested) return fail(new KarmiError("approval.notFound", `No Approval was requested at seq ${seq}.`));
    // A request of a finished Turn was answered by the answer, the clock or the cancel that ended it.
    const request =
      row.state === "idle" || requested.turn !== row.turn ? undefined : this.readTurn(row).requests.get(seq);
    if (!request || request.answered)
      return fail(new KarmiError("approval.resolved", `The Approval at seq ${seq} has already been answered.`));
    if (answer.decision !== "allow" && answer.decision !== "deny")
      return fail(new KarmiError("approval.invalid", `An Approval answer is "allow" or "deny".`));
    this.resolve(row, seq, request, answer, "answer");
    await this.settle(row);
    return ok(undefined);
  }

  async cancel(address: ThreadAddress): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (row.state === "idle") return ok(undefined);
    if (this.active) {
      // The loop owns the Turn: it notices the abort at once (or as soon as the park's Hooks return) and ends the Turn itself.
      this.update({ cancelled: 1 });
      this.turnAbort.abort();
      return ok(undefined);
    }
    await this.cancelTurn(row);
    this.kickIfQueued();
    return ok(undefined);
  }

  async resume(address: ThreadAddress): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (row.state !== "parked" || this.readTurn(row).paused !== "scope_suspended")
      return fail(new KarmiError("thread.notParked", `Thread "${row.thread_id}" is not parked by a Scope suspension.`));
    const status = await this.scopeStub(row).status(row.scope_id);
    if (!status.ok) return status;
    if (status.value.state === "suspended")
      return fail(new KarmiError("scope.suspended", `Scope "${row.scope_id}" is still suspended.`));
    // The operator resumed on purpose; the Turn goes on under whatever the Scope says now.
    this.update({ snapshot_json: null });
    this.wake(row, "resume");
    return ok(undefined);
  }

  async job(
    address: ThreadAddress,
    event: Extract<ThreadEventData, { type: "job.progress" | "job.completed" | "job.failed" | "job.cancelled" }>,
  ): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    const turn = row.state === "idle" ? undefined : this.readTurn(row);
    const pending = turn && [...turn.jobs.values()].some((job) => job.jobId === event.jobId && !job.outcome);
    if (!pending)
      return fail(new KarmiError("job.notFound", `No Job "${event.jobId}" is pending on the current Step.`));
    this.append(row.turn, event, this.turnInput(row.turn)?.channelRef);
    if (event.type !== "job.progress") await this.settle(row);
    return ok(undefined);
  }

  /** A Compaction outside any Turn: the Thread must be idle, and stays busy to a `send` until it is done. */
  async compact(address: ThreadAddress, options: CompactOptions): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (row.state !== "idle" || this.active)
      return fail(new KarmiError("thread.busy", `Thread "${row.thread_id}" has a Turn running or parked.`));
    if (this.head === 0) return ok(undefined);
    this.active = true;
    this.turnAbort = new AbortController();
    try {
      const boundary = await this.snapshot(row);
      if (!boundary.ok)
        return fail(
          boundary.failure.type === "turn.failed"
            ? new KarmiError("compaction.failed", boundary.failure.message)
            : new KarmiError("scope.suspended", `Scope "${row.scope_id}" is suspended.`),
        );
      const n = this.readTurn(row).lastStep + 1;
      const result = await this.compactStep(row, boundary.snapshot, n, "manual", options.instructions, undefined);
      if (result.status === "failed") return fail(new KarmiError("compaction.failed", result.message));
      return ok(undefined);
    } finally {
      this.update({ snapshot_json: null });
      this.active = false;
      this.kickIfQueued();
    }
  }

  /** Copies the log up to `seq` into the Thread at `target`, which must not exist yet. */
  async fork(address: ThreadAddress, seq: number, target: ThreadAddress): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    if (!Number.isInteger(seq) || seq < 1 || seq > this.head)
      return fail(new KarmiError("thread.seq.invalid", `The log ends at seq ${this.head}; cannot fork at ${seq}.`));
    const rows = this.sql
      .exec<EventRow>("SELECT seq, turn, at, type, json FROM events WHERE seq <= ? ORDER BY seq", seq)
      .toArray();
    const stub = remote<ThreadDurableObject>(this.env.KARMI_THREADS, keys.thread(target.scope, target.threadId));
    return stub.seed(target, rows);
  }

  /** The receiving side of a fork: a fresh Durable Object takes the copied rows as its own log. */
  seed(address: ThreadAddress, rows: EventRow[]): Outcome<void> {
    if (this.sql.exec("SELECT thread_id FROM thread").toArray().length > 0)
      return fail(new KarmiError("thread.exists", `Thread "${address.threadId}" already exists.`));
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const last = rows.at(-1);
    for (const row of rows)
      this.sql.exec(
        "INSERT INTO events (seq, turn, at, type, json) VALUES (?, ?, ?, ?, ?)",
        row.seq,
        row.turn,
        row.at,
        row.type,
        row.json,
      );
    if (last) {
      this.head = last.seq;
      this.update({ turn: last.turn });
    }
    return ok(undefined);
  }

  private nextAppend(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve();
      }, POLL_TIMEOUT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  private read(
    after: number,
    granularity: Granularity,
    limit: number,
    through = Number.MAX_SAFE_INTEGER,
  ): ThreadEvent[] {
    const excluded: ThreadEventType[] =
      granularity === "delta" ? [] : granularity === "part" ? ["message.delta"] : ["message.delta", "message.part"];
    const rows =
      excluded.length === 0
        ? this.sql.exec<EventRow>(
            "SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
            after,
            through,
            limit,
          )
        : this.sql.exec<EventRow>(
            `SELECT * FROM events WHERE seq > ? AND seq <= ? AND type NOT IN (${excluded.map(() => "?").join(", ")}) ORDER BY seq LIMIT ?`,
            after,
            through,
            ...excluded,
            limit,
          );
    return rows.toArray().map((row) => ({ seq: row.seq, turn: row.turn, at: row.at, ...decodeEvent(row.json) }));
  }

  private append(
    turn: number,
    data: ThreadEventData,
    channelRef: unknown,
    at = this.deployment.clock.now(),
  ): ThreadEvent {
    const seq = ++this.head;
    const body = channelRef === undefined ? data : { ...data, channelRef };
    const event: ThreadEvent = { seq, turn, at, ...body };
    this.sql.exec(
      "INSERT INTO events (seq, turn, at, type, json) VALUES (?, ?, ?, ?, ?)",
      seq,
      turn,
      at,
      data.type,
      JSON.stringify(body),
    );
    if (data.type === "turn.completed" || data.type === "approval.requested") {
      const route = this.sql.exec<{ json: string }>("SELECT json FROM delivery_route WHERE id = 1").toArray()[0];
      if (route) {
        const previous = this.sql
          .exec<{ seq: number | null }>("SELECT MAX(to_seq) AS seq FROM deliveries WHERE turn = ?", turn)
          .one().seq;
        const first =
          previous === null
            ? this.sql.exec<{ seq: number }>("SELECT MIN(seq) AS seq FROM events WHERE turn = ?", turn).one().seq
            : previous + 1;
        this.sql.exec(
          "INSERT INTO deliveries (to_seq, from_seq, turn, binding_json) VALUES (?, ?, ?, ?)",
          seq,
          first,
          turn,
          route.json,
        );
        // Give a live subscriber time to acknowledge the trigger; the Queue checks again before delivery.
        this.scheduler.set({ id: `delivery:${seq}`, kind: "delivery", dueAt: at + 1000, payload: { toSeq: seq } });
      }
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    return event;
  }

  private update(
    patch: Partial<Omit<ThreadRow, "scope_id" | "agent_id" | "user_id" | "thread_id" | "created_at">>,
  ): void {
    const columns = Object.keys(patch);
    this.sql.exec(`UPDATE thread SET ${columns.map((column) => `${column} = ?`).join(", ")}`, ...Object.values(patch));
  }

  private row(): ThreadRow {
    return this.sql.exec<ThreadRow>("SELECT * FROM thread").one();
  }

  private hasInputs(): boolean {
    return this.sql.exec("SELECT id FROM inputs LIMIT 1").toArray().length > 0;
  }

  private kick(recovering: boolean): void {
    this.armWatchdog();
    // DO lifetime is independent of the caller. Persisted work, rather than waitUntil, survives eviction.
    void this.run(recovering).catch((error: unknown) => {
      console.error("Thread loop interrupted", error);
    });
  }

  private kickIfQueued(): void {
    if (!this.active && this.hasInputs()) this.kick(false);
  }

  private armWatchdog(): void {
    this.scheduler.set({
      id: "watchdog",
      kind: "watchdog",
      dueAt: this.deployment.clock.now() + STEP_WATCHDOG_MS,
      payload: null,
    });
  }

  protected override async runJob(job: ScheduledJob): Promise<void> {
    if (job.kind === "delivery") {
      const row = this.row();
      const { toSeq } = job.payload as { toSeq: number };
      const delivery = this.sql
        .exec<{ from_seq: number; consumed: number }>(
          "SELECT from_seq, consumed FROM deliveries WHERE to_seq = ?",
          toSeq,
        )
        .toArray()[0];
      if (!delivery || delivery.consumed) return;
      const status = await this.scopeStub(row).status(row.scope_id);
      if (!status.ok) throw new KarmiError(status.code, status.message);
      if (status.value.state === "destroying" || status.value.state === "destroyed") return;
      if (!this.env.KARMI_QUEUE) throw new KarmiError("bindings.missing", "Offline delivery requires KARMI_QUEUE.");
      await this.env.KARMI_QUEUE.send({
        kind: "delivery",
        scope: row.scope_id,
        threadKey: encodeKey({
          agent: row.agent_id,
          threadId: row.thread_id,
          ...(row.user_id !== null && { user: row.user_id }),
        }),
        fromSeq: delivery.from_seq,
        toSeq,
      });
      return;
    }
    if (job.kind === "park-timeout") return this.expire(job.payload as { seq: number });
    if (job.kind !== "watchdog") return super.runJob(job);
    const row = this.sql.exec<ThreadRow>("SELECT * FROM thread").toArray()[0];
    if (!row || row.state === "parked" || (row.state === "idle" && !this.hasInputs())) {
      this.scheduler.cancel("watchdog");
      return;
    }
    // A live invocation owns the Step. Its alarm is also the keep-alive heartbeat while streaming.
    if (this.active) this.armWatchdog();
    else this.kick(row.state === "running");
  }

  // The Turn loop: one instance at a time, driven by `send`, the watchdog alarm and the answers that
  // wake a parked Turn. It resumes whatever the row says is in flight, then drains queued inputs.
  private async run(recovering: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      // The Catalogue is fixed for the Deployment, so one fingerprint serves every Turn of this run.
      const toolsVersion = await this.deployment.catalogue.fingerprint();
      for (;;) {
        let row = this.row();
        if (row.state !== "idle" && row.cancelled) {
          await this.cancelTurn(row);
          continue;
        }
        if (row.state === "parked") {
          if (!(this.readTurn(row).paused === "scope_suspended" && this.hasInputs())) return;
          this.wake(row, "input", false);
          row = this.row();
        } else if (row.state === "idle") {
          if (!this.startTurn(row, toolsVersion)) {
            this.scheduler.cancel("watchdog");
            return;
          }
          row = this.row();
        }
        if (recovering) {
          recovering = false;
          if ((await this.recover(row)) === "stop") continue;
          row = this.row();
        }
        this.armWatchdog();
        await this.turn(row);
        // A parked Turn or a platform failure waits for its answer or watchdog, rather than spinning here;
        // an answer or cancel that landed during the park's Hooks is picked up by the next iteration.
        const after = this.row();
        if (after.platform_failure || (after.state === "parked" && !after.cancelled)) return;
      }
    } finally {
      this.active = false;
    }
  }

  /** Starts the next Turn from the queued inputs; false when nothing is queued. */
  private startTurn(row: ThreadRow, toolsVersion: string): boolean {
    // Nothing may yield between taking the inputs and logging them, or an eviction would lose them.
    const queued = this.sql.exec<{ json: string }>("SELECT json FROM inputs ORDER BY id").toArray();
    const [first, ...rest] = queued.map((next) => decodeInput(next.json));
    if (!first) return false;
    const turn = row.turn + 1;
    this.sql.exec("DELETE FROM inputs");
    this.update({
      state: "running",
      turn,
      step: 0,
      attempt: 0,
      recoveries: 0,
      platform_failure: 0,
      cancelled: 0,
      snapshot_json: null,
    });
    this.append(turn, { type: "turn.started", input: first, toolsVersion }, first.channelRef);
    for (const input of rest) this.append(turn, { type: "turn.input", input }, first.channelRef);
    return true;
  }

  /** Counts an interrupted Step's recovery; stops when the Step has no attempts left and the Turn failed. */
  private async recover(row: ThreadRow): Promise<Next> {
    const plan = this.readTurn(row).plan;
    if (plan.kind === "compact" || (plan.kind !== "finish" && !plan.fresh)) {
      if (!row.platform_failure && row.recoveries + 1 >= MAX_STEP_ATTEMPTS) {
        const message = `Step ${row.step} of Turn ${row.turn} exhausted its three attempts.`;
        return stop(this.finish(row, failure("recovery", message)));
      }
      this.update({ recoveries: row.recoveries + (row.platform_failure ? 0 : 1), platform_failure: 0 });
    }
    this.append(row.turn, { type: "turn.resumed", reason: "recovered" }, this.turnInput(row.turn)?.channelRef);
    return "continue";
  }

  private turnInput(turn: number): TurnInput | undefined {
    const row = this.sql
      .exec<{ json: string }>("SELECT json FROM events WHERE turn = ? AND type = 'turn.started' LIMIT 1", turn)
      .toArray()[0];
    const event = row && decodeEvent(row.json);
    return event?.type === "turn.started" ? event.input : undefined;
  }

  /** Brings a parked Turn back to running; the loop is kicked unless the caller is the loop. */
  private wake(row: ThreadRow, reason: ResumeReason, kick = true): void {
    this.append(row.turn, { type: "turn.resumed", reason }, this.turnInput(row.turn)?.channelRef);
    this.update({ state: "running" });
    if (kick) this.kick(false);
  }

  private async finish(row: ThreadRow, end: TurnEnd): Promise<void> {
    this.append(row.turn, end, this.turnInput(row.turn)?.channelRef);
    if (end.type === "turn.paused") this.update({ state: "parked" });
    else
      this.update({
        state: "idle",
        step: 0,
        attempt: 0,
        recoveries: 0,
        platform_failure: 0,
        cancelled: 0,
        snapshot_json: null,
      });
    if (end.type !== "turn.paused" && this.hasInputs()) this.armWatchdog();
    else this.scheduler.cancel("watchdog");
    // The snapshot is gone from the row by now; a Turn that never took one has no Hooks to run.
    const snapshot = row.snapshot_json === null ? undefined : decodeSnapshot(row.snapshot_json);
    if (snapshot) {
      if (end.type === "turn.failed")
        await this.turnHooks(row, snapshot, "on-error", { error: { code: end.reason, message: end.message } });
      await this.turnHooks(row, snapshot, "after-turn", { end });
    }
    this.turnAbort.abort();
  }

  // Approvals: one request per asked call or per exhausted budget, answered once, by a human, the
  // clock or a cancel. Answering is one append; `settle` decides whether the Turn goes on.
  /** `timeoutAt` is measured from the request's own `at`, so the two never drift apart. */
  private request(row: ThreadRow, snapshot: TurnSnapshot, data: ApprovalRequest, channelRef: unknown): void {
    const at = this.deployment.clock.now();
    const timeoutAt = at + snapshot.approvalTimeout;
    const { seq } = this.append(row.turn, { ...data, timeoutAt }, channelRef, at);
    this.scheduler.set({ id: `park-timeout:${seq}`, kind: "park-timeout", dueAt: timeoutAt, payload: { seq } });
  }

  private resolve(row: ThreadRow, seq: number, request: Request, answer: ApprovalAnswer, source: ApprovalSource): void {
    const remember = answer.remember === true && answer.decision === "allow" && request.kind === "tool";
    this.append(
      row.turn,
      {
        type: "approval.resolved",
        request: seq,
        kind: request.kind,
        ...(request.kind === "tool" && { tool: request.tool }),
        decision: answer.decision,
        ...(answer.reason !== undefined && { reason: answer.reason }),
        ...(remember && { remember }),
        ...(answer.by !== undefined && { by: answer.by }),
        source,
      },
      this.turnInput(row.turn)?.channelRef,
    );
    this.scheduler.cancel(`park-timeout:${seq}`);
    request.answered = true;
  }

  private async expire({ seq }: { seq: number }): Promise<void> {
    const row = this.sql.exec<ThreadRow>("SELECT * FROM thread").toArray()[0];
    if (!row || row.state === "idle") return;
    const request = this.readTurn(row).requests.get(seq);
    if (!request || request.answered) return;
    this.resolve(row, seq, request, { decision: "deny" }, "timeout");
    await this.settle(row);
  }

  /** After an answer or a Job outcome: a parked Turn with nothing left to wait for goes on, or ends on a refused continue. */
  private async settle(row: ThreadRow): Promise<void> {
    if (this.row().state !== "parked") return;
    const turn = this.readTurn(row);
    if (this.waiting(turn) !== undefined) return;
    // An allowed `continue` leaves no request behind; a refused one ends the Turn.
    for (const request of turn.requests.values()) {
      if (request.kind !== "continue") continue;
      await this.finish(this.row(), { type: "turn.completed", stopReason: "budget", message: turn.lastMessage });
      this.kickIfQueued();
      return;
    }
    this.wake(row, turn.paused === "job" ? "job" : "approval");
  }

  private async cancelTurn(row: ThreadRow): Promise<void> {
    const turn = this.readTurn(row);
    for (const [seq, request] of turn.requests)
      if (!request.answered) this.resolve(row, seq, request, { decision: "deny" }, "cancel");
    for (const job of turn.jobs.values())
      if (!job.outcome)
        this.append(row.turn, { type: "job.cancelled", jobId: job.jobId }, this.turnInput(row.turn)?.channelRef);
    this.turnAbort.abort();
    await this.finish(this.row(), failure("cancelled", "The Turn was cancelled."));
  }

  // One Turn from wherever the log says it stands: model Steps and tool Steps alternate until a model
  // Step ends without tool calls. `attempt` on a model Step indexes the fallback list, so an eviction
  // re-runs the same model and only a Provider failure rotates; on a tool Step it counts recoveries.
  private async turn(row: ThreadRow): Promise<void> {
    this.turnAbort = new AbortController();
    try {
      await this.steps(row);
    } catch (caught) {
      if (isPlatformFailure(caught)) {
        this.update({ platform_failure: 1 });
        this.turnAbort.abort();
        this.armWatchdog();
        return;
      }
      // A bug, not an eviction: end the Turn honestly rather than leave it to the watchdog.
      await this.finish(this.row(), failure("internal", errorMessage(caught)));
    }
  }

  private async steps(row: ThreadRow): Promise<void> {
    const channelRef = this.turnInput(row.turn)?.channelRef;
    const available = this.toolSet(row);
    for (;;) {
      const boundary = await this.snapshot(row);
      if (this.row().cancelled) return this.cancelTurn(this.row());
      if (!boundary.ok) return this.finish(this.row(), boundary.failure);
      const { snapshot } = boundary;
      if (row.step === 0 && (await this.beforeTurn(row, snapshot)) === "stop") return;
      const turn = this.joinSteers(row, this.readTurn(row), channelRef);
      const { plan } = turn;
      if (plan.kind === "finish")
        return this.finish(this.row(), { type: "turn.completed", stopReason: plan.stopReason, message: plan.message });
      if (plan.kind !== "compact" && plan.fresh && exhausted(turn.budget, snapshot.budget))
        return this.parkOnBudget(row, snapshot, turn, channelRef);
      let next: Next;
      if (plan.kind === "compact") next = await this.resumeCompactStep(row, snapshot, plan.n, plan.trigger, channelRef);
      else if (plan.kind === "model" && plan.fresh && turn.compaction === undefined && this.compactionDue(snapshot))
        next = await this.runCompactStep(row, snapshot, plan.n, "auto", channelRef);
      else if (plan.kind === "model")
        next = await this.startModelStep(row, snapshot, plan, available(snapshot), channelRef, turn);
      else next = await this.startToolStep(row, snapshot, plan, available(snapshot), channelRef);
      if (next === "stop") return;
      row = this.row();
    }
  }

  /** The Tool set is a function of the snapshot and the Thread's remembered allows, which only grow. */
  private toolSet(row: ThreadRow): (snapshot: TurnSnapshot) => Map<string, AvailableTool> {
    let cached: { remembered: number; available: Map<string, AvailableTool> } | undefined;
    return (snapshot) => {
      const remembered = this.remembered();
      if (cached?.remembered !== remembered.size) {
        const builtIns = [readOutputTool(this.env.KARMI_MEDIA, row.scope_id, row.thread_id)];
        const available = resolveTools(snapshot.spec, this.deployment.catalogue, snapshot.policy, builtIns, remembered);
        cached = { remembered: remembered.size, available };
      }
      return cached.available;
    };
  }

  private async beforeTurn(row: ThreadRow, snapshot: TurnSnapshot): Promise<Next> {
    const input = this.turnInput(row.turn);
    const before = input && (await this.turnHooks(row, snapshot, "before-turn", { input }));
    if (this.row().cancelled) return stop(this.cancelTurn(this.row()));
    if (before && !before.ok) return stop(this.finish(this.row(), before.failure));
    return "continue";
  }

  /** At a batch boundary, steer inputs join the conversation before the next model Step. */
  private joinSteers(row: ThreadRow, turn: TurnState, channelRef: unknown): TurnState {
    if (turn.plan.kind === "compact" || (turn.plan.kind !== "finish" && !turn.plan.fresh)) return turn;
    const steers = this.sql.exec<{ json: string }>("SELECT json FROM inputs WHERE steer = 1 ORDER BY id").toArray();
    if (steers.length === 0) return turn;
    this.sql.exec("DELETE FROM inputs WHERE steer = 1");
    for (const next of steers)
      this.append(row.turn, { type: "turn.input", input: decodeInput(next.json), steer: true }, channelRef);
    return this.readTurn(row);
  }

  /** Parks the Turn on its spent budget, asking to continue unless an unanswered ask already exists. */
  private parkOnBudget(row: ThreadRow, snapshot: TurnSnapshot, turn: TurnState, channelRef: unknown): Promise<void> {
    const asked = [...turn.requests.values()].some((request) => request.kind === "continue" && !request.answered);
    if (!asked)
      this.request(row, snapshot, { type: "approval.requested", kind: "continue", budget: turn.budget }, channelRef);
    return this.finish(this.row(), { type: "turn.paused", reason: "budget" });
  }

  private async startModelStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    plan: ModelPlan,
    available: ReadonlyMap<string, AvailableTool>,
    channelRef: unknown,
    turn: TurnState,
  ): Promise<Next> {
    const modelAttempt = plan.fresh ? 1 : Math.max(row.attempt, 1);
    const attempt = modelAttempt + (plan.fresh ? 0 : row.recoveries);
    const model = [snapshot.spec.model.id, ...(snapshot.spec.model.fallbacks ?? [])][modelAttempt - 1];
    if (model === undefined)
      return stop(this.finish(this.row(), failure("provider", `Every model of Agent "${row.agent_id}" failed.`)));
    if (attempt > MAX_STEP_ATTEMPTS) {
      const message = `Step ${plan.n} of Turn ${row.turn} exhausted its three attempts.`;
      return stop(this.finish(this.row(), failure("recovery", message)));
    }
    this.update({ step: plan.n, attempt: modelAttempt, ...(plan.fresh && { recoveries: 0, platform_failure: 0 }) });
    this.append(
      row.turn,
      {
        type: "step.started",
        kind: "model",
        n: plan.n,
        attempt,
        model,
        provider: snapshot.profile.adapter,
        agentVersion: snapshot.agentVersion,
      },
      channelRef,
    );
    this.armWatchdog();
    const step = this.modelStep({ ...row, step: plan.n }, snapshot, available, model, channelRef);
    const result = await this.untilCancelled(step);
    if (result === CANCELLED) return stop(this.cancelTurn(this.row()));
    // An overflow asks for a Compaction before anything else is tried; one that drops nothing (or a
    // Compaction this Step already followed) leaves the failure to take its ordinary course.
    const overflow = result.ok
      ? result.stopReason === "context_window_exceeded"
      : result.error.code === "context_window_exceeded";
    if (overflow && turn.compaction !== "skipped") {
      const compacted = await this.compactStep(this.row(), snapshot, plan.n + 1, "overflow", undefined, channelRef);
      if (compacted.status === "failed") return stop(this.finish(this.row(), failure("compaction", compacted.message)));
      if (compacted.status === "compacted") return "continue";
    }
    // The failed attempt stays in the log; the transcript ignores Steps that never completed.
    if (!result.ok) this.update({ attempt: modelAttempt + 1 });
    return "continue";
  }

  private async startToolStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    plan: ToolPlan,
    available: ReadonlyMap<string, AvailableTool>,
    channelRef: unknown,
  ): Promise<Next> {
    const attempt = (plan.fresh ? 0 : row.recoveries) + 1;
    this.update({ step: plan.n, attempt, ...(plan.fresh && { recoveries: 0, platform_failure: 0 }) });
    this.append(
      row.turn,
      { type: "step.started", kind: "tool", n: plan.n, attempt, agentVersion: snapshot.agentVersion },
      channelRef,
    );
    this.armWatchdog();
    const { batch, prior } = plan;
    const step = this.toolStep({ ...row, step: plan.n }, snapshot, available, attempt, batch, prior, channelRef);
    const waits = await this.untilCancelled(step);
    if (waits === CANCELLED) return stop(this.cancelTurn(this.row()));
    if (waits === undefined) {
      this.append(row.turn, { type: "step.completed", kind: "tool", n: plan.n }, channelRef);
      return "continue";
    }
    // An answer may have landed while the batch was still running; only a real wait parks.
    const waitsOn = this.waiting(this.readTurn(row));
    if (waitsOn !== undefined) return stop(this.finish(this.row(), { type: "turn.paused", reason: waitsOn }));
    return "continue";
  }

  /** What the current Step still waits on, if anything. */
  private waiting(turn: TurnState): Extract<PauseReason, "approval" | "job"> | undefined {
    for (const request of turn.requests.values()) if (!request.answered) return "approval";
    for (const job of turn.jobs.values()) if (!job.outcome) return "job";
    return undefined;
  }

  private untilCancelled<T>(work: Promise<T>): Promise<T | typeof CANCELLED> {
    const signal = this.turnAbort.signal;
    if (signal.aborted) return Promise.resolve(CANCELLED);
    return Promise.race([
      work,
      new Promise<typeof CANCELLED>((resolve) =>
        signal.addEventListener("abort", () => resolve(CANCELLED), { once: true }),
      ),
    ]);
  }

  /** Tool names allowed for the rest of the Thread by a remembered `allow`. */
  private remembered(): Set<string> {
    const names = new Set<string>();
    for (const { json } of this.sql.exec<{ json: string }>(
      "SELECT json FROM events WHERE type = 'approval.resolved'",
    )) {
      const event = decodeEvent(json);
      if (
        event.type === "approval.resolved" &&
        event.remember &&
        event.decision === "allow" &&
        event.tool !== undefined
      )
        names.add(event.tool);
    }
    return names;
  }

  private readTurn(row: ThreadRow): TurnState {
    const rows = this.sql
      .exec<EventRow>("SELECT * FROM events WHERE turn = ? AND type NOT IN ('message.delta') ORDER BY seq", row.turn)
      .toArray();
    const events = rows.map(({ seq, at, json }) => ({ seq, at, event: decodeEvent(json) }));
    return foldTurn(events, this.deployment.clock.now());
  }

  // The Step boundary: the first Step takes the Turn snapshot from the Scope and persists it; every
  // Step checks the Scope is still active.
  private async snapshot(
    row: ThreadRow,
  ): Promise<{ ok: true; snapshot: TurnSnapshot } | { ok: false; failure: TurnEnd }> {
    const stub = this.scopeStub(row);
    let snapshot: TurnSnapshot;
    let state: string;
    if (row.snapshot_json !== null) {
      const status = await stub.status(row.scope_id);
      if (!status.ok) return { ok: false, failure: failure(status.code, status.message) };
      snapshot = decodeSnapshot(row.snapshot_json);
      state = status.value.state;
    } else {
      const input = this.turnInput(row.turn);
      const title = input ? titleOf(input) : undefined;
      const source = await stub.turnSnapshot(row.scope_id, row.agent_id, {
        threadId: row.thread_id,
        ...(row.user_id !== null && { userId: row.user_id }),
        createdAt: row.created_at,
        activeAt: this.deployment.clock.now(),
        ...(title !== undefined && { title }),
      });
      if (!source.ok) return { ok: false, failure: failure(source.code, source.message) };
      const { version } = source.value.agent;
      const spec = source.value.agent.spec as AgentSpec;
      const profile = resolveProfile(spec, source.value.config.providers ?? {});
      if (!profile)
        return {
          ok: false,
          failure: failure("provider.profile.unknown", `Agent "${row.agent_id}" names no configured Provider profile.`),
        };
      const ceilings = source.value.config.ceilings ?? {};
      snapshot = {
        agentVersion: version,
        spec,
        profile,
        policy: [...(source.value.config.policy ?? []), ...(spec.policy ?? [])],
        approvalTimeout: Math.min(
          spec.approvals?.timeout ?? AGENT_SPEC_DEFAULTS.approvals.timeout,
          ceilings.approvals?.timeout ?? UNBOUNDED,
        ),
        budget: resolveBudget(spec.capabilities?.longRunning, ceilings.longRunning),
        context: resolveContext(spec, ceilings),
      };
      const json = JSON.stringify(snapshot);
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > SNAPSHOT_LIMIT)
        return {
          ok: false,
          failure: failure("snapshot.too-large", `Turn snapshot is ${bytes} bytes; the limit is ${SNAPSHOT_LIMIT}.`),
        };
      this.update({ snapshot_json: json, agent_version: version });
      state = source.value.state;
    }
    if (state === "suspended") return { ok: false, failure: { type: "turn.paused", reason: "scope_suspended" } };
    if (state !== "active")
      return { ok: false, failure: failure("scope.destroyed", `Scope "${row.scope_id}" has been destroyed.`) };
    return { ok: true, snapshot };
  }

  private scopeStub(row: ThreadRow) {
    return remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(row.scope_id));
  }

  private logger(row: ThreadRow): Logger {
    return consoleLogger({ scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn });
  }

  // Turn-level Hooks, dispatched by name with the Turn's context. `before-turn` and `before-compact`
  // may refuse by throwing, and the first `before-compact` decision wins; the observing points only
  // log a failure.
  private async turnHooks<P extends "before-turn" | "after-turn" | "on-error" | "before-compact" | "after-compact">(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    point: P,
    extra: Omit<HookContexts[P], keyof HookContextBase>,
  ): Promise<{ ok: true; result?: Exclude<HookResults[P], void> } | { ok: false; failure: TurnEnd }> {
    const base: HookContextBase = {
      point,
      scope: row.scope_id,
      ...(row.user_id !== null && { user: row.user_id }),
      thread: { id: row.thread_id },
      agent: row.agent_id,
      turn: row.turn,
      logger: this.logger(row),
      signal: this.turnAbort.signal,
    };
    for (const hook of hooksAt(snapshot.spec, this.deployment.catalogue, point)) {
      try {
        const result = await hook.run({ ...base, ...extra } as HookContexts[P]);
        if (result !== undefined && point === "before-compact")
          return { ok: true, result: result as Exclude<HookResults[P], void> };
      } catch (caught) {
        if (isPlatformFailure(caught)) throw caught;
        const message = errorMessage(caught);
        if (point === "before-turn")
          return { ok: false, failure: failure("hook", `Hook "${hook.name}" refused the Turn: ${message}`) };
        if (point === "before-compact")
          return { ok: false, failure: failure("hook", `Hook "${hook.name}" refused the Compaction: ${message}`) };
        base.logger.warn(`${point} Hook "${hook.name}" failed`, { error: message });
      }
    }
    return { ok: true };
  }

  // Compaction: a Step of its own, run before a fresh model Step when the context is over its limit,
  // after a `context_window_exceeded` stop, or on `thread.compact()`. Its only lasting trace is
  // `thread.compacted`; the log before the cut is never touched.
  /** The events the next model call is built from: from the last Compaction's `firstKeptSeq` on. */
  private contextLog(): { events: ThreadEvent[]; floor: number } {
    const last = this.sql
      .exec<{ seq: number; json: string }>(
        "SELECT seq, json FROM events WHERE type = 'thread.compacted' ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    const compacted = last && decodeEvent(last.json);
    const firstKeptSeq = compacted?.type === "thread.compacted" ? compacted.firstKeptSeq : 1;
    return { events: this.read(firstKeptSeq - 1, "part", Number.MAX_SAFE_INTEGER), floor: last?.seq ?? 0 };
  }

  private limits(snapshot: TurnSnapshot): ContextLimits {
    const { context, profile, spec } = snapshot;
    const [, native] = splitModelId(spec.model.id);
    const model = this.deployment.providers[profile.adapter]?.capabilities(native).contextWindow;
    return {
      window: resolveWindow({
        ...(context.window !== undefined && { spec: context.window }),
        ...(context.windowCeiling !== undefined && { ceiling: context.windowCeiling }),
        ...(model !== undefined && { model }),
      }),
      reserveTokens: context.reserveTokens,
      keepRecentTokens: context.keepRecentTokens,
    };
  }

  private compactionDue(snapshot: TurnSnapshot): boolean {
    return overLimit(contextTokens(this.contextLog().events), this.limits(snapshot));
  }

  private async runCompactStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    channelRef: unknown,
  ): Promise<Next> {
    const result = await this.compactStep(row, snapshot, n, trigger, undefined, channelRef);
    if (result.status === "failed") return stop(this.finish(this.row(), failure("compaction", result.message)));
    return "continue";
  }

  /** An interrupted compact Step re-runs whole: nothing of it was logged but its start. */
  private resumeCompactStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    channelRef: unknown,
  ): Promise<Next> {
    if (row.recoveries + 1 > MAX_STEP_ATTEMPTS) {
      const message = `Step ${n} of Turn ${row.turn} exhausted its three attempts.`;
      return stop(this.finish(this.row(), failure("recovery", message)));
    }
    return this.runCompactStep(row, snapshot, n, trigger, channelRef);
  }

  private async compactStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    instructions: string | undefined,
    channelRef: unknown,
  ): Promise<CompactResult> {
    const { spec, profile } = snapshot;
    this.update({ step: n, attempt: 1 });
    const started: ThreadEventData = {
      type: "step.started",
      kind: "compact",
      n,
      attempt: row.recoveries + 1,
      model: spec.model.id,
      provider: profile.adapter,
      agentVersion: snapshot.agentVersion,
      trigger,
    };
    this.append(row.turn, started, channelRef);
    this.armWatchdog();
    const completed = () => this.append(row.turn, { type: "step.completed", kind: "compact", n }, channelRef);
    const { events, floor } = this.contextLog();
    const tokensBefore = contextTokens(events);
    const cut = chooseCut(events, this.limits(snapshot), floor);
    if (!cut) return skipped(completed);
    const before = await this.turnHooks(row, snapshot, "before-compact", {
      trigger,
      ...(instructions !== undefined && { instructions }),
      tokensBefore,
    });
    if (!before.ok)
      return { status: "failed", message: before.failure.type === "turn.failed" ? before.failure.message : "" };
    if (before.result && "skip" in before.result) return skipped(completed);
    const dropped = events.filter((event) => event.seq < cut.firstKeptSeq);
    const [, native] = splitModelId(spec.model.id);
    let summary: Summary;
    if (before.result) summary = { strategy: "hook", summary: before.result.summary, usage: ZERO_USAGE };
    else {
      const written = await this.untilCancelled(this.summarise(row, snapshot, dropped, native, instructions));
      if (written === CANCELLED) return { status: "failed", message: "The Turn was cancelled." };
      if (!written.ok) return { status: "failed", message: written.message };
      summary = written.value;
    }
    const compacted: Compacted = {
      type: "thread.compacted",
      trigger,
      ...summary,
      firstKeptSeq: cut.firstKeptSeq,
      tokensBefore,
      tokensAfter: estimateTokens(summary.summary) + cut.tokensKept,
      provider: profile.adapter,
      model: native,
      attachments: attachmentsOf(dropped),
    };
    return this.recordCompaction(row, snapshot, compacted, completed, channelRef);
  }

  /** The summary lands in one breath: its usage, the event and the Step's end, then the observing Hooks. */
  private async recordCompaction(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    compacted: Compacted,
    completed: () => unknown,
    channelRef: unknown,
  ): Promise<CompactResult> {
    this.update({ usage_json: JSON.stringify(addUsage(decodeUsage(this.row().usage_json), compacted.usage)) });
    this.append(row.turn, compacted, channelRef);
    completed();
    await this.turnHooks(row, snapshot, "after-compact", { compacted });
    return { status: "compacted" };
  }

  /** One summarising call: the Harness asks for prose, or the provider is asked for its own block. */
  private async summarise(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    dropped: ThreadEvent[],
    native: string,
    instructions: string | undefined,
  ): Promise<{ ok: true; value: Summary } | { ok: false; message: string }> {
    const { profile, spec } = snapshot;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return { ok: false, message: `Provider adapter "${profile.adapter}" is not registered.` };
    const strategy = profile.compaction ?? "harness";
    const { messages } = prepareMessages(transcriptFromEvents(dropped), { provider: profile.adapter, model: native });
    const request: ProviderRequest = {
      model: native,
      config: profile,
      messages: [...messages, { role: "user", content: [{ type: "text", text: summaryInstruction(instructions) }] }],
      ...(strategy === "harness" && { system: SUMMARY_SYSTEM }),
      ...(strategy === "provider" && { compact: { ...(instructions !== undefined && { instructions }) } }),
      ...(spec.model.params?.maxOutputTokens && { params: { maxOutputTokens: spec.model.params.maxOutputTokens } }),
      ...((profile.providerOptions || spec.model.providerOptions) && {
        providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions },
      }),
    };
    const logger = this.logger(row);
    const hosts = providerHosts(profile);
    const egress = scopedFetch({ ...(hosts && { hosts }), logger });
    const attribution = { scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn };
    const parts: ContentBlock[] = [];
    let usage = ZERO_USAGE;
    try {
      const stream = provider.stream(request, { fetch: egress, signal: this.turnAbort.signal, attribution, logger });
      for await (const event of stream) {
        if (event.type === "part") parts.push(event.block);
        else if (event.type === "error") return { ok: false, message: event.error.message };
        else if (event.type === "message.end") usage = event.usage;
      }
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      return { ok: false, message: errorMessage(error) };
    }
    if (strategy === "provider") {
      const block = parts.find((part) => part.type === "compaction");
      if (!block) return { ok: false, message: `Provider "${profile.adapter}" returned no compaction block.` };
      return {
        ok: true,
        value: { strategy, summary: block.summary, ...(block.raw !== undefined && { raw: block.raw }), usage },
      };
    }
    const summary = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (!summary.trim()) return { ok: false, message: "The summarising call returned no text." };
    return { ok: true, value: { strategy, summary, usage } };
  }

  private async modelStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ReadonlyMap<string, AvailableTool>,
    model: string,
    channelRef: unknown,
  ): Promise<StepResult> {
    const { profile } = snapshot;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return stepError(`Provider adapter "${profile.adapter}" is not registered.`);
    const signal = this.turnAbort.signal;
    const logger = this.logger(row);
    try {
      const request = await this.modelRequest(row, snapshot, available, model);
      const hosts = providerHosts(profile);
      const egress = scopedFetch({ ...(hosts && { hosts }), logger });
      const attribution = { scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn };
      const stream = provider.stream(request, { fetch: egress, signal, attribution, logger });
      return await this.recordStream(row, stream, signal, channelRef);
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      return stepError(errorMessage(error));
    }
  }

  /** The Provider request for one model Step: the Prompt, the replayed transcript and the offered Tools. */
  private async modelRequest(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ReadonlyMap<string, AvailableTool>,
    model: string,
  ): Promise<ProviderRequest> {
    const { spec, profile } = snapshot;
    const [, native] = splitModelId(model);
    const tools = toolDefinitions(available);
    const offered = [...available.values()].flatMap(({ tool, effect }) => (effect === "deny" ? [] : [tool]));
    const system = await evaluatePrompt(
      spec,
      this.deployment.catalogue,
      {
        model,
        scope: row.scope_id,
        ...(row.user_id !== null && { user: row.user_id }),
        thread: { id: row.thread_id },
        tools: tools.map((tool) => tool.name),
        now: new Date(this.deployment.clock.now()),
      },
      offered,
    );
    const { messages } = prepareMessages(transcriptFromEvents(this.contextLog().events), {
      provider: profile.adapter,
      model: native,
    });
    return {
      model: native,
      config: profile,
      ...(system !== undefined && { system }),
      messages,
      ...(tools.length > 0 && { tools }),
      ...(spec.model.params && { params: spec.model.params }),
      ...((profile.providerOptions || spec.model.providerOptions) && {
        providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions },
      }),
    };
  }

  /** Logs a Provider stream as it arrives and ends the model Step on its terminal event. */
  private async recordStream(
    row: ThreadRow,
    stream: AsyncIterable<ProviderEvent>,
    signal: AbortSignal,
    channelRef: unknown,
  ): Promise<StepResult> {
    const parts: ContentBlock[] = [];
    for await (const event of stream) {
      // A cancelled Turn has ended; nothing of this stream belongs in the log any more.
      if (signal.aborted) return stepError("The Turn was cancelled.");
      switch (event.type) {
        case "delta":
          this.append(
            row.turn,
            { type: "message.delta", index: event.index, kind: event.kind, text: event.text },
            channelRef,
          );
          break;
        case "part":
          parts[event.index] = event.block;
          this.append(row.turn, { type: "message.part", index: event.index, block: event.block }, channelRef);
          break;
        case "message.end": {
          const usage = addUsage(decodeUsage(this.row().usage_json), event.usage);
          this.update({ usage_json: JSON.stringify(usage) });
          this.append(
            row.turn,
            { type: "step.completed", kind: "model", n: row.step, stopReason: event.stopReason, usage: event.usage },
            channelRef,
          );
          return { ok: true, stopReason: event.stopReason, message: parts.filter((part) => part !== undefined) };
        }
        case "error":
          return { ok: false, error: event.error };
        default:
          break;
      }
    }
    return stepError("The Provider stream ended without a terminal event.");
  }

  private toolStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ReadonlyMap<string, AvailableTool>,
    attempt: number,
    batch: ToolCall[],
    prior: PriorCalls,
    channelRef: unknown,
  ): ReturnType<typeof runToolStep> {
    const stub = this.scopeStub(row);
    const signal = this.turnAbort.signal;
    return runToolStep(
      {
        scope: row.scope_id,
        ...(row.user_id !== null && { user: row.user_id }),
        threadId: row.thread_id,
        agent: row.agent_id,
        turn: row.turn,
        attempt,
        spec: snapshot.spec,
        catalogue: this.deployment.catalogue,
        available,
        bucket: this.env.KARMI_MEDIA,
        logger: this.logger(row),
        signal,
        append: (data) => {
          signal.throwIfAborted();
          return this.append(row.turn, data, channelRef);
        },
        ask: (call) => {
          signal.throwIfAborted();
          this.request(
            row,
            snapshot,
            { type: "approval.requested", kind: "tool", id: call.id, tool: call.name, input: call.input },
            channelRef,
          );
        },
        connection: async (level, name) => {
          // The user-level store lands with the Connection ticket; until then only agent-level values exist.
          if (level === "user") return undefined;
          const value = await stub.connectionGet(row.scope_id, row.agent_id, name);
          return value.ok ? value.value : undefined;
        },
      },
      batch,
      prior,
    );
  }
}

export type { TurnEnd } from "./hook.js";

export function isTurnEnd(event: ThreadEventData): event is TurnEnd {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused";
}

const failure = (reason: string, message: string): TurnEnd => ({ type: "turn.failed", reason, message });
const stop = async (work: Promise<void>): Promise<"stop"> => {
  await work;
  return "stop";
};
/** A compact Step called off still closes: the fold must see it completed. */
const skipped = (completed: () => unknown): CompactResult => {
  completed();
  return { status: "skipped" };
};
const stepError = (message: string): StepResult => ({
  ok: false,
  error: { code: "unknown", message, retryable: false },
});

function resolveProfile(spec: AgentSpec, providers: Record<string, ProviderConfig>): ProviderConfig | undefined {
  const name =
    spec.model.providerProfile ?? (Object.keys(providers).length === 1 ? Object.keys(providers)[0] : undefined);
  return name === undefined ? undefined : providers[name];
}

/** A grant lifts each bound it names and leaves the others open; the Scope ceiling caps all of them. */
function resolveBudget(grant: Capabilities["longRunning"], ceiling: Ceilings["longRunning"]): Budget {
  const limits = (bounds: { maxSteps?: number; maxWallMs?: number; maxTokens?: number }): Budget => ({
    steps: bounds.maxSteps ?? UNBOUNDED,
    wallMs: bounds.maxWallMs ?? UNBOUNDED,
    tokens: bounds.maxTokens ?? UNBOUNDED,
  });
  const budget = grant ? limits(grant) : { ...DEFAULT_BUDGET };
  if (!ceiling) return budget;
  const cap = limits(ceiling);
  return {
    steps: Math.min(budget.steps, cap.steps),
    wallMs: Math.min(budget.wallMs, cap.wallMs),
    tokens: Math.min(budget.tokens, cap.tokens),
  };
}

/** The Spec's context knobs with the defaults filled in; the window itself waits for the model's own. */
function resolveContext(spec: AgentSpec, ceilings: Ceilings): TurnSnapshot["context"] {
  return {
    ...(spec.context?.window !== undefined && { window: spec.context.window }),
    ...(ceilings.context?.window !== undefined && { windowCeiling: ceilings.context.window }),
    reserveTokens: spec.context?.reserveTokens ?? AGENT_SPEC_DEFAULTS.context.reserveTokens,
    keepRecentTokens: spec.context?.keepRecentTokens ?? AGENT_SPEC_DEFAULTS.context.keepRecentTokens,
  };
}

function exhausted(used: Budget, max: Budget): boolean {
  return used.steps >= max.steps || used.wallMs >= max.wallMs || used.tokens >= max.tokens;
}

function addUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
  };
}
