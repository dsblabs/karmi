import { AGENT_SPEC_DEFAULTS } from "./agent-spec.js";
import type { AgentSpec, Capabilities, PolicyRule } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import { readOutputTool } from "./builtins.js";
import type { Logger } from "./context.js";
import type { Deployment } from "./deployment.js";
import { KarmiError } from "./errors.js";
import type { HookContextBase, HookContexts, TurnEnd } from "./hook.js";
import { hooksAt } from "./hooks.js";
import { keys } from "./keys.js";
import { consoleLogger } from "./logger.js";
import { fail, ok, remote, type Outcome } from "./outcome.js";
import { isPlatformFailure } from "./platform-failure.js";
import { evaluatePrompt } from "./prompt.js";
import type { ContentBlock, ProviderError, StopReason, Usage } from "./provider.js";
import { prepareMessages } from "./replay.js";
import { ScheduledDurableObject, type ScheduledJob } from "./scheduler.js";
import type { ScopeConfigDurableObject } from "./scope-config-do.js";
import type { Ceilings, ProviderConfig } from "./scope-config.js";
import type { ApprovalAnswer, BudgetUsed, Granularity, PauseReason, ResumeReason, ThreadEvent, ThreadEventData, ThreadEventType, TurnInput } from "./thread-events.js";
import { titleOf, type PendingApproval, type ThreadAddress, type ThreadStatus } from "./thread.js";
import { runToolStep, type CallApproval, type JobOutcome, type PriorCalls, type ToolCall } from "./tool-step.js";
import { resolveTools, toolDefinitions, type AvailableTool } from "./tools.js";
import { splitModelId, transcriptFromEvents } from "./transcript.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread (scope_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, attempt INTEGER NOT NULL, recoveries INTEGER NOT NULL, agent_version INTEGER, snapshot_json TEXT, usage_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
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
export const DEFAULT_BUDGET: Readonly<TurnBudget> = Object.freeze({ steps: 25, wallMs: 10 * 60_000, tokens: 500_000 });
/** A granted `longRunning` bound the Spec leaves out; JSON has no Infinity. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const CANCELLED = Symbol("cancelled");

export interface TurnBudget {
  steps: number;
  wallMs: number;
  tokens: number;
}

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
  budget: TurnBudget;
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
type InputRow = { id: number; json: string; steer: number };

/** A model Step outcome: the Provider finished, or it failed and the next fallback should try. */
type StepResult = { ok: true; stopReason: StopReason; message: ContentBlock[] } | { ok: false; error: ProviderError };

/**
 * What the log says the Turn should do next: re-run or start a model Step, run the tool batch of the
 * last model Step (re-runs carry what already happened), or end with the last model Step's message.
 */
type Plan = { kind: "model"; n: number; fresh: boolean } | { kind: "tool"; n: number; fresh: boolean; batch: ToolCall[]; prior: PriorCalls } | { kind: "finish"; stopReason: StopReason; message: ContentBlock[] };

type Request = { kind: "tool"; id: string; tool: string; timeoutAt: number; answered: boolean } | { kind: "continue"; timeoutAt: number; answered: boolean };

/** The Turn as the log tells it: the next Step, what it waits on, and what it has spent. */
interface TurnState {
  plan: Plan;
  budget: BudgetUsed;
  /** Set while the Turn is parked. */
  paused?: PauseReason;
  /** Every `approval.requested` of the current Step, by its seq. */
  requests: Map<number, Request>;
  /** The current tool Step's asks by tool-call id. */
  approvals: Map<string, CallApproval>;
  /** The current tool Step's Jobs by tool-call id. */
  jobs: Map<string, { jobId: string; outcome?: JobOutcome }>;
  /** The last completed model Step's content, for a Turn that ends without another one. */
  lastMessage: ContentBlock[];
}

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
    const columns = (table: string) => new Set(ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name));
    if (!columns("thread").has("platform_failure")) {
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN platform_failure INTEGER NOT NULL DEFAULT 0");
      // Preserve the raw watchdog installed by versions predating the jobs table.
      ctx.storage.sql.exec("INSERT OR IGNORE INTO jobs (id, kind, dueAt, payload, attempt, generation) SELECT 'watchdog', 'watchdog', 0, 'null', 0, ? FROM thread WHERE state = 'running'", crypto.randomUUID());
    }
    if (!columns("thread").has("cancelled")) ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0");
    if (!columns("inputs").has("steer")) ctx.storage.sql.exec("ALTER TABLE inputs ADD COLUMN steer INTEGER NOT NULL DEFAULT 0");
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
      if (!address.create) return fail(new KarmiError("thread.notFound", `Thread "${address.threadId}" does not exist.`));
      row = { scope_id: address.scope, agent_id: address.agent, user_id: address.user ?? null, thread_id: address.threadId, created_at: this.deployment.clock.now(), state: "idle", turn: 0, step: 0, attempt: 0, recoveries: 0, platform_failure: 0, cancelled: 0, agent_version: null, snapshot_json: null, usage_json: JSON.stringify(ZERO_USAGE) };
      this.sql.exec("INSERT INTO thread (scope_id, agent_id, user_id, thread_id, created_at, state, turn, step, attempt, recoveries, agent_version, snapshot_json, usage_json) VALUES (?, ?, ?, ?, ?, 'idle', 0, 0, 0, 0, NULL, NULL, ?)", row.scope_id, row.agent_id, row.user_id, row.thread_id, row.created_at, row.usage_json);
    } else if (row.scope_id !== address.scope || row.thread_id !== address.threadId) {
      throw new Error(`Thread "${row.scope_id}/${row.thread_id}" was addressed as "${address.scope}/${address.threadId}".`);
    } else if (row.agent_id !== address.agent || row.user_id !== (address.user ?? null)) {
      return fail(new KarmiError("thread.mismatch", `Thread "${address.threadId}" belongs to Agent "${row.agent_id}"${row.user_id === null ? "" : ` and User "${row.user_id}"`}.`));
    }
    return ok(row);
  }

  send(address: ThreadAddress, input: TurnInput, steer = false): Outcome<{ turn: number; seq: number }> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    // A steer joins the Turn in flight; anything else coalesces into the one next Turn.
    const joins = steer && row.state !== "idle";
    this.sql.exec("INSERT INTO inputs (turn, json, steer) VALUES (?, ?, ?)", joins ? row.turn : row.turn + 1, JSON.stringify(input), joins ? 1 : 0);
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
    const status: ThreadStatus = { state: row.state, ...(row.agent_version !== null && { agentVersion: row.agent_version }), usage: JSON.parse(row.usage_json) as Usage, seq: this.head };
    if (row.state === "idle") return ok(status);
    const turn = this.readTurn(row);
    status.turn = row.turn;
    status.step = row.step;
    if (turn.paused) status.paused = turn.paused;
    if (row.snapshot_json !== null) status.budget = { ...turn.budget, max: (JSON.parse(row.snapshot_json) as TurnSnapshot).budget };
    const pending: PendingApproval[] = [];
    for (const [seq, request] of turn.requests) if (!request.answered) pending.push({ seq, kind: request.kind, ...(request.kind === "tool" && { tool: request.tool }), timeoutAt: request.timeoutAt });
    if (pending.length > 0) status.pendingApprovals = pending;
    return ok(status);
  }

  /** Returns the next events after `after`, waiting for the first one when the log has nothing yet. */
  async poll(address: ThreadAddress, after: number, granularity: Granularity): Promise<Outcome<ThreadEvent[]>> {
    const row = this.enter(address);
    if (!row.ok) return row;
    if (after > this.head) return fail(new KarmiError("thread.seq.invalid", `The log ends at seq ${this.head}; cannot subscribe after ${after}.`));
    if (after === this.head) await this.nextAppend();
    return ok(this.read(after, granularity, POLL_LIMIT));
  }

  async approve(address: ThreadAddress, seq: number, answer: ApprovalAnswer): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    const requested = this.sql.exec<{ turn: number }>("SELECT turn FROM events WHERE seq = ? AND type = 'approval.requested'", seq).toArray()[0];
    if (!requested) return fail(new KarmiError("approval.notFound", `No Approval was requested at seq ${seq}.`));
    // A request of a finished Turn was answered by the answer, the clock or the cancel that ended it.
    const request = row.state === "idle" || requested.turn !== row.turn ? undefined : this.readTurn(row).requests.get(seq);
    if (!request || request.answered) return fail(new KarmiError("approval.resolved", `The Approval at seq ${seq} has already been answered.`));
    if (answer.decision !== "allow" && answer.decision !== "deny") return fail(new KarmiError("approval.invalid", `An Approval answer is "allow" or "deny".`));
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
      // The loop owns the Turn: it notices the abort at once and ends the Turn itself.
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
    if (row.state !== "parked" || this.readTurn(row).paused !== "scope_suspended") return fail(new KarmiError("thread.notParked", `Thread "${row.thread_id}" is not parked by a Scope suspension.`));
    const status = await this.scopeStub(row).status(row.scope_id);
    if (!status.ok) return status;
    if (status.value.state === "suspended") return fail(new KarmiError("scope.suspended", `Scope "${row.scope_id}" is still suspended.`));
    // The operator resumed on purpose; the Turn goes on under whatever the Scope says now.
    this.update({ snapshot_json: null });
    this.wake(row, "resume");
    return ok(undefined);
  }

  async job(address: ThreadAddress, event: Extract<ThreadEventData, { type: "job.progress" | "job.completed" | "job.failed" | "job.cancelled" }>): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    const turn = row.state === "idle" ? undefined : this.readTurn(row);
    const pending = turn && [...turn.jobs.values()].some((job) => job.jobId === event.jobId && !job.outcome);
    if (!pending) return fail(new KarmiError("job.notFound", `No Job "${event.jobId}" is pending on the current Step.`));
    this.append(row.turn, event, this.turnInput(row.turn)?.channelRef);
    if (event.type !== "job.progress") await this.settle(row);
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

  private read(after: number, granularity: Granularity, limit: number): ThreadEvent[] {
    const excluded: ThreadEventType[] = granularity === "delta" ? [] : granularity === "part" ? ["message.delta"] : ["message.delta", "message.part"];
    const rows =
      excluded.length === 0
        ? this.sql.exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
        : this.sql.exec<EventRow>(`SELECT * FROM events WHERE seq > ? AND type NOT IN (${excluded.map(() => "?").join(", ")}) ORDER BY seq LIMIT ?`, after, ...excluded, limit);
    return rows.toArray().map((row) => ({ seq: row.seq, turn: row.turn, at: row.at, ...(JSON.parse(row.json) as ThreadEventData) }));
  }

  private append(turn: number, data: ThreadEventData, channelRef: unknown): ThreadEvent {
    const seq = ++this.head;
    const at = this.deployment.clock.now();
    const body = channelRef === undefined ? data : { ...data, channelRef };
    const event: ThreadEvent = { seq, turn, at, ...body };
    this.sql.exec("INSERT INTO events (seq, turn, at, type, json) VALUES (?, ?, ?, ?, ?)", seq, turn, at, data.type, JSON.stringify(body));
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    return event;
  }

  private update(patch: Partial<Omit<ThreadRow, "scope_id" | "agent_id" | "user_id" | "thread_id" | "created_at">>): void {
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
    this.scheduler.set({ id: "watchdog", kind: "watchdog", dueAt: this.deployment.clock.now() + STEP_WATCHDOG_MS, payload: null });
  }

  protected override async runJob(job: ScheduledJob): Promise<void> {
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
        if (row.state === "running" && row.cancelled) {
          await this.cancelTurn(row);
          continue;
        }
        if (row.state === "parked") {
          if (!(this.readTurn(row).paused === "scope_suspended" && this.hasInputs())) return;
          this.wake(row, "input", false);
          row = this.row();
        } else if (row.state === "idle") {
          // Nothing may yield between taking the inputs and logging them, or an eviction would lose them.
          const queued = this.sql.exec<InputRow>("SELECT id, json, steer FROM inputs ORDER BY id").toArray();
          if (queued.length === 0) {
            this.scheduler.cancel("watchdog");
            return;
          }
          const inputs = queued.map((next) => JSON.parse(next.json) as TurnInput);
          const turn = row.turn + 1;
          this.sql.exec("DELETE FROM inputs");
          this.update({ state: "running", turn, step: 0, attempt: 0, recoveries: 0, platform_failure: 0, cancelled: 0, snapshot_json: null });
          const [first, ...rest] = inputs as [TurnInput, ...TurnInput[]];
          this.append(turn, { type: "turn.started", input: first, toolsVersion }, first.channelRef);
          for (const input of rest) this.append(turn, { type: "turn.input", input }, first.channelRef);
          row = this.row();
        }
        if (recovering) {
          recovering = false;
          const plan = this.readTurn(row).plan;
          if (plan.kind !== "finish" && !plan.fresh) {
            if (!row.platform_failure && row.recoveries + 1 >= MAX_STEP_ATTEMPTS) {
              await this.finish(row, failure("recovery", `Step ${row.step} of Turn ${row.turn} exhausted its three attempts.`));
              continue;
            }
            this.update({ recoveries: row.recoveries + (row.platform_failure ? 0 : 1), platform_failure: 0 });
          }
          this.append(row.turn, { type: "turn.resumed", reason: "recovered" }, this.turnInput(row.turn)?.channelRef);
          row = this.row();
        }
        this.armWatchdog();
        await this.turn(row);
        // A parked Turn or a platform failure waits for input or its watchdog, rather than spinning here.
        if (this.row().state !== "idle") return;
      }
    } finally {
      this.active = false;
    }
  }

  private turnInput(turn: number): TurnInput | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM events WHERE turn = ? AND type = 'turn.started' LIMIT 1", turn).toArray()[0];
    return row ? (JSON.parse(row.json) as { input: TurnInput }).input : undefined;
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
    else this.update({ state: "idle", step: 0, attempt: 0, recoveries: 0, platform_failure: 0, cancelled: 0, snapshot_json: null });
    if (end.type !== "turn.paused" && this.hasInputs()) this.armWatchdog();
    else this.scheduler.cancel("watchdog");
    // The snapshot is gone from the row by now; a Turn that never took one has no Hooks to run.
    const snapshot = row.snapshot_json === null ? undefined : (JSON.parse(row.snapshot_json) as TurnSnapshot);
    if (snapshot) {
      if (end.type === "turn.failed") await this.turnHooks(row, snapshot, "on-error", { error: { code: end.reason, message: end.message } });
      await this.turnHooks(row, snapshot, "after-turn", { end });
    }
    this.turnAbort.abort();
  }

  // Approvals: one request per asked call or per exhausted budget, answered once, by a human, the
  // clock or a cancel. Answering is one append; `settle` decides whether the Turn goes on.
  private request(row: ThreadRow, data: Extract<ThreadEventData, { type: "approval.requested" }>, channelRef: unknown): void {
    const { seq } = this.append(row.turn, data, channelRef);
    this.scheduler.set({ id: `park-timeout:${seq}`, kind: "park-timeout", dueAt: data.timeoutAt, payload: { seq } });
  }

  private resolve(row: ThreadRow, seq: number, request: Request, answer: ApprovalAnswer, source: "answer" | "timeout" | "cancel"): void {
    const remember = answer.remember === true && answer.decision === "allow" && request.kind === "tool";
    this.append(row.turn, { type: "approval.resolved", request: seq, kind: request.kind, ...(request.kind === "tool" && { tool: request.tool }), decision: answer.decision, ...(answer.reason !== undefined && { reason: answer.reason }), ...(remember && { remember }), ...(answer.by !== undefined && { by: answer.by }), source }, this.turnInput(row.turn)?.channelRef);
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
    for (const request of turn.requests.values()) if (!request.answered) return;
    for (const job of turn.jobs.values()) if (!job.outcome) return;
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
    for (const [seq, request] of turn.requests) if (!request.answered) this.resolve(row, seq, request, { decision: "deny" }, "cancel");
    for (const job of turn.jobs.values()) if (!job.outcome) this.append(row.turn, { type: "job.cancelled", jobId: job.jobId }, this.turnInput(row.turn)?.channelRef);
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
      await this.finish(this.row(), failure("internal", caught instanceof Error ? caught.message : String(caught)));
    }
  }

  private async steps(row: ThreadRow): Promise<void> {
    const channelRef = this.turnInput(row.turn)?.channelRef;
    // The Tool set is a function of the snapshot and the Thread's remembered allows, which only grow.
    let tools: { remembered: number; available: ReturnType<typeof resolveTools> } | undefined;
    const available = (snapshot: TurnSnapshot) => {
      const remembered = this.remembered();
      if (tools?.remembered !== remembered.size) tools = { remembered: remembered.size, available: resolveTools(snapshot.spec, this.deployment.catalogue, snapshot.policy, [readOutputTool(this.env.KARMI_MEDIA, row.scope_id, row.thread_id)], remembered) };
      return tools.available;
    };
    for (;;) {
      const boundary = await this.snapshot(row);
      if (!boundary.ok) return this.finish(this.row(), boundary.failure);
      const snapshot = boundary.snapshot;
      if (row.step === 0) {
        const input = this.turnInput(row.turn);
        const before = input && (await this.turnHooks(row, snapshot, "before-turn", { input }));
        if (before && !before.ok) return this.finish(this.row(), before.failure);
      }
      let turn = this.readTurn(row);
      if (turn.plan.kind === "finish" || turn.plan.fresh) {
        // A batch boundary: steer inputs join the conversation before the next model Step.
        const steers = this.sql.exec<InputRow>("SELECT id, json, steer FROM inputs WHERE steer = 1 ORDER BY id").toArray();
        if (steers.length > 0) {
          this.sql.exec("DELETE FROM inputs WHERE steer = 1");
          for (const next of steers) this.append(row.turn, { type: "turn.input", input: JSON.parse(next.json) as TurnInput, steer: true }, channelRef);
          turn = this.readTurn(row);
        }
      }
      const { plan } = turn;
      if (plan.kind === "finish") return this.finish(this.row(), { type: "turn.completed", stopReason: plan.stopReason, message: plan.message });

      if (plan.fresh && exhausted(turn.budget, snapshot.budget)) {
        for (const request of turn.requests.values()) if (request.kind === "continue" && !request.answered) return this.finish(this.row(), { type: "turn.paused", reason: "budget" });
        this.request(row, { type: "approval.requested", kind: "continue", budget: turn.budget, timeoutAt: this.deployment.clock.now() + snapshot.approvalTimeout }, channelRef);
        return this.finish(this.row(), { type: "turn.paused", reason: "budget" });
      }

      if (plan.kind === "model") {
        const modelAttempt = plan.fresh ? 1 : Math.max(row.attempt, 1);
        const attempt = modelAttempt + (plan.fresh ? 0 : row.recoveries);
        const models = [snapshot.spec.model.id, ...(snapshot.spec.model.fallbacks ?? [])];
        const model = models[modelAttempt - 1];
        if (model === undefined) return this.finish(this.row(), failure("provider", `Every model of Agent "${row.agent_id}" failed.`));
        if (attempt > MAX_STEP_ATTEMPTS) return this.finish(this.row(), failure("recovery", `Step ${plan.n} of Turn ${row.turn} exhausted its three attempts.`));
        this.update({ step: plan.n, attempt: modelAttempt, ...(plan.fresh && { recoveries: 0, platform_failure: 0 }) });
        this.append(row.turn, { type: "step.started", kind: "model", n: plan.n, attempt, model, provider: snapshot.profile.adapter, agentVersion: snapshot.agentVersion }, channelRef);
        this.armWatchdog();
        const result = await this.untilCancelled(this.modelStep({ ...row, step: plan.n }, snapshot, available(snapshot), model, channelRef));
        if (result === CANCELLED) return this.cancelTurn(this.row());
        // The failed attempt stays in the log; the transcript ignores Steps that never completed.
        if (!result.ok) this.update({ attempt: modelAttempt + 1 });
      } else {
        const attempt = (plan.fresh ? 0 : row.recoveries) + 1;
        this.update({ step: plan.n, attempt, ...(plan.fresh && { recoveries: 0, platform_failure: 0 }) });
        this.append(row.turn, { type: "step.started", kind: "tool", n: plan.n, attempt, agentVersion: snapshot.agentVersion }, channelRef);
        this.armWatchdog();
        const waits = await this.untilCancelled(this.toolStep({ ...row, step: plan.n }, snapshot, available(snapshot), attempt, plan.batch, plan.prior, channelRef));
        if (waits === CANCELLED) return this.cancelTurn(this.row());
        if (waits !== undefined) {
          // An answer may have landed while the batch was still running; only a real wait parks.
          const still = this.waiting(this.readTurn(row));
          if (still !== undefined) return this.finish(this.row(), { type: "turn.paused", reason: still });
          row = this.row();
          continue;
        }
        this.append(row.turn, { type: "step.completed", kind: "tool", n: plan.n }, channelRef);
      }
      row = this.row();
    }
  }

  /** What the current Step still waits on, if anything. */
  private waiting(turn: TurnState): Extract<PauseReason, "approval" | "job"> | undefined {
    for (const request of turn.requests.values()) if (!request.answered) return "approval";
    for (const job of turn.jobs.values()) if (!job.outcome) return "job";
    return undefined;
  }

  private untilCancelled<T>(work: Promise<T>): Promise<T | typeof CANCELLED> {
    const signal = this.turnAbort.signal;
    return Promise.race([work, new Promise<typeof CANCELLED>((resolve) => signal.addEventListener("abort", () => resolve(CANCELLED), { once: true }))]);
  }

  /** Tool names allowed for the rest of the Thread by a remembered `allow`. */
  private remembered(): Set<string> {
    const names = new Set<string>();
    for (const { json } of this.sql.exec<{ json: string }>("SELECT json FROM events WHERE type = 'approval.resolved'")) {
      const event = JSON.parse(json) as Extract<ThreadEventData, { type: "approval.resolved" }>;
      if (event.remember && event.decision === "allow" && event.tool !== undefined) names.add(event.tool);
    }
    return names;
  }

  // Reads the Turn back from the log. Results, started calls, asks and Jobs are kept across re-runs of
  // the same tool Step and dropped only when a new model Step starts a new batch; the budget window
  // reopens at an allowed `continue`.
  private readTurn(row: ThreadRow): TurnState {
    const events = this.sql.exec<EventRow>("SELECT * FROM events WHERE turn = ? AND type NOT IN ('message.delta') ORDER BY seq", row.turn).toArray();
    let started: { kind: "model" | "tool"; n: number } | undefined;
    let completed = true;
    let steered = false;
    let parts: ContentBlock[] = [];
    let last: { stopReason: StopReason; message: ContentBlock[] } | undefined;
    const calls = new Map<string, { seq: number; input: unknown }>();
    const results = new Set<string>();
    const requests = new Map<number, Request>();
    const approvals = new Map<string, CallApproval>();
    const jobs = new Map<string, { jobId: string; outcome?: JobOutcome }>();
    const byJob = new Map<string, string>();
    const budget: BudgetUsed = { steps: 0, wallMs: 0, tokens: 0 };
    let countedStep = 0;
    let since: number | undefined;
    let paused: PauseReason | undefined;
    for (const { seq, at, json } of events) {
      const event = JSON.parse(json) as ThreadEventData;
      switch (event.type) {
        case "turn.started":
        case "turn.resumed":
          since = at;
          paused = undefined;
          break;
        case "turn.paused":
          if (since !== undefined) budget.wallMs += at - since;
          since = undefined;
          paused = event.reason;
          break;
        case "turn.input":
          steered = true;
          break;
        case "step.started":
          started = { kind: event.kind, n: event.n };
          completed = false;
          steered = false;
          requests.clear();
          if (event.n > countedStep) {
            countedStep = event.n;
            budget.steps++;
          }
          if (event.kind === "model") {
            parts = [];
            calls.clear();
            results.clear();
            approvals.clear();
            jobs.clear();
            byJob.clear();
          }
          break;
        case "message.part":
          parts[event.index] = event.block;
          break;
        case "tool.call":
          calls.set(event.id, { seq, input: event.input });
          break;
        case "tool.result":
          results.add(event.id);
          break;
        case "step.completed":
          completed = true;
          if (event.kind === "model") {
            last = { stopReason: event.stopReason, message: parts.filter((part) => part !== undefined) };
            budget.tokens += event.usage.input + event.usage.output;
          }
          break;
        case "approval.requested":
          if (event.kind === "tool") {
            requests.set(seq, { kind: "tool", id: event.id, tool: event.tool, timeoutAt: event.timeoutAt, answered: false });
            approvals.set(event.id, { request: seq });
          } else requests.set(seq, { kind: "continue", timeoutAt: event.timeoutAt, answered: false });
          break;
        case "approval.resolved": {
          const request = requests.get(event.request);
          if (!request) break;
          request.answered = true;
          if (request.kind === "tool") approvals.set(request.id, { request: event.request, answer: { decision: event.decision, ...(event.reason !== undefined && { reason: event.reason }), source: event.source } });
          else if (event.decision === "allow") {
            requests.delete(event.request);
            budget.steps = 0;
            budget.tokens = 0;
            budget.wallMs = 0;
          }
          break;
        }
        case "job.started":
          jobs.set(event.id, { jobId: event.jobId });
          byJob.set(event.jobId, event.id);
          break;
        case "job.completed":
        case "job.failed":
        case "job.cancelled": {
          const id = byJob.get(event.jobId);
          const job = id === undefined ? undefined : jobs.get(id);
          if (job) job.outcome = event;
          break;
        }
        default:
          break;
      }
    }
    if (since !== undefined) budget.wallMs += this.deployment.clock.now() - since;
    const prior: PriorCalls = { started: calls, finished: results, approvals, jobs };
    const batch = (): ToolCall[] => (last?.message ?? []).flatMap((block) => (block.type === "tool_call" ? [{ id: block.id, name: block.name, input: block.input }] : []));
    const state = { budget, requests, approvals, jobs, lastMessage: last?.message ?? [], ...(paused !== undefined && { paused }) };
    if (started && !completed) {
      if (started.kind === "model") return { ...state, plan: { kind: "model", n: started.n, fresh: false } };
      return { ...state, plan: { kind: "tool", n: started.n, fresh: false, batch: batch(), prior } };
    }
    if (!started || !last) return { ...state, plan: { kind: "model", n: 1, fresh: true } };
    if (started.kind === "tool" || steered) return { ...state, plan: { kind: "model", n: started.n + 1, fresh: true } };
    const pending = batch();
    if (pending.length > 0) return { ...state, plan: { kind: "tool", n: started.n + 1, fresh: true, batch: pending, prior } };
    return { ...state, plan: { kind: "finish", stopReason: last.stopReason, message: last.message } };
  }

  // The Step boundary: the first Step takes the Turn snapshot from the Scope and persists it; every
  // Step checks the Scope is still active.
  private async snapshot(row: ThreadRow): Promise<{ ok: true; snapshot: TurnSnapshot } | { ok: false; failure: TurnEnd }> {
    const stub = this.scopeStub(row);
    let snapshot: TurnSnapshot;
    let state: string;
    if (row.snapshot_json !== null) {
      const status = await stub.status(row.scope_id);
      if (!status.ok) return { ok: false, failure: failure(status.code, status.message) };
      snapshot = JSON.parse(row.snapshot_json) as TurnSnapshot;
      state = status.value.state;
    } else {
      const input = this.turnInput(row.turn);
      const title = input ? titleOf(input) : undefined;
      const source = await stub.turnSnapshot(row.scope_id, row.agent_id, { threadId: row.thread_id, ...(row.user_id !== null && { userId: row.user_id }), createdAt: row.created_at, activeAt: this.deployment.clock.now(), ...(title !== undefined && { title }) });
      if (!source.ok) return { ok: false, failure: failure(source.code, source.message) };
      const { version } = source.value.agent;
      const spec = source.value.agent.spec as AgentSpec;
      const profile = resolveProfile(spec, source.value.config.providers ?? {});
      if (!profile) return { ok: false, failure: failure("provider.profile.unknown", `Agent "${row.agent_id}" names no configured Provider profile.`) };
      const ceilings = source.value.config.ceilings ?? {};
      snapshot = {
        agentVersion: version,
        spec,
        profile,
        policy: [...(source.value.config.policy ?? []), ...(spec.policy ?? [])],
        approvalTimeout: Math.min(spec.approvals?.timeout ?? AGENT_SPEC_DEFAULTS.approvals.timeout, ceilings.approvals?.timeout ?? UNBOUNDED),
        budget: resolveBudget(spec.capabilities?.longRunning, ceilings.longRunning),
      };
      const json = JSON.stringify(snapshot);
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > SNAPSHOT_LIMIT) return { ok: false, failure: failure("snapshot.too-large", `Turn snapshot is ${bytes} bytes; the limit is ${SNAPSHOT_LIMIT}.`) };
      this.update({ snapshot_json: json, agent_version: version });
      state = source.value.state;
    }
    if (state === "suspended") return { ok: false, failure: { type: "turn.paused", reason: "scope_suspended" } };
    if (state !== "active") return { ok: false, failure: failure("scope.destroyed", `Scope "${row.scope_id}" has been destroyed.`) };
    return { ok: true, snapshot };
  }

  private scopeStub(row: ThreadRow) {
    return remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(row.scope_id));
  }

  private logger(row: ThreadRow): Logger {
    return consoleLogger({ scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn });
  }

  // Turn-level Hooks, dispatched by name with the Turn's context. `before-turn` may refuse the Turn by
  // throwing; the observing points only log a failure.
  private async turnHooks<P extends "before-turn" | "after-turn" | "on-error">(row: ThreadRow, snapshot: TurnSnapshot, point: P, extra: Omit<HookContexts[P], keyof HookContextBase>): Promise<{ ok: true } | { ok: false; failure: TurnEnd }> {
    const base: HookContextBase = { point, scope: row.scope_id, ...(row.user_id !== null && { user: row.user_id }), thread: { id: row.thread_id }, agent: row.agent_id, turn: row.turn, logger: this.logger(row), signal: this.turnAbort.signal };
    for (const hook of hooksAt(snapshot.spec, this.deployment.catalogue, point)) {
      try {
        await hook.run({ ...base, ...extra } as HookContexts[P]);
      } catch (caught) {
        if (isPlatformFailure(caught)) throw caught;
        const message = caught instanceof Error ? caught.message : String(caught);
        if (point === "before-turn") return { ok: false, failure: failure("hook", `Hook "${hook.name}" refused the Turn: ${message}`) };
        base.logger.warn(`${point} Hook "${hook.name}" failed`, { error: message });
      }
    }
    return { ok: true };
  }

  private async modelStep(row: ThreadRow, snapshot: TurnSnapshot, available: ReadonlyMap<string, AvailableTool>, model: string, channelRef: unknown): Promise<StepResult> {
    const { spec, profile } = snapshot;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return stepError(`Provider adapter "${profile.adapter}" is not registered.`);
    const [, native] = splitModelId(model);
    const parts: ContentBlock[] = [];
    const signal = this.turnAbort.signal;
    try {
      const tools = toolDefinitions(available);
      const offered = tools.map((tool) => available.get(tool.name)!.tool);
      const system = await evaluatePrompt(spec, this.deployment.catalogue, { model, scope: row.scope_id, ...(row.user_id !== null && { user: row.user_id }), thread: { id: row.thread_id }, tools: tools.map((tool) => tool.name), now: new Date(this.deployment.clock.now()) }, offered);
      const { messages } = prepareMessages(transcriptFromEvents(this.read(0, "part", Number.MAX_SAFE_INTEGER)), { provider: profile.adapter, model: native });
      const request = {
        model: native,
        config: profile,
        ...(system !== undefined && { system }),
        messages,
        ...(tools.length > 0 && { tools }),
        ...(spec.model.params && { params: spec.model.params }),
        ...((profile.providerOptions || spec.model.providerOptions) && { providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions } }),
      };
      for await (const event of provider.stream(request, { fetch, signal })) {
        // A cancelled Turn has ended; nothing of this stream belongs in the log any more.
        if (signal.aborted) return stepError("The Turn was cancelled.");
        switch (event.type) {
          case "delta":
            this.append(row.turn, { type: "message.delta", index: event.index, kind: event.kind, text: event.text }, channelRef);
            break;
          case "part":
            parts[event.index] = event.block;
            this.append(row.turn, { type: "message.part", index: event.index, block: event.block }, channelRef);
            break;
          case "message.end": {
            const usage = addUsage(JSON.parse(this.row().usage_json) as Usage, event.usage);
            this.update({ usage_json: JSON.stringify(usage) });
            this.append(row.turn, { type: "step.completed", kind: "model", n: row.step, stopReason: event.stopReason, usage: event.usage }, channelRef);
            return { ok: true, stopReason: event.stopReason, message: parts.filter((part) => part !== undefined) };
          }
          case "error":
            return { ok: false, error: event.error };
          default:
            break;
        }
      }
      return stepError("The Provider stream ended without a terminal event.");
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      return stepError(error instanceof Error ? error.message : String(error));
    }
  }

  private toolStep(row: ThreadRow, snapshot: TurnSnapshot, available: ReadonlyMap<string, AvailableTool>, attempt: number, batch: ToolCall[], prior: PriorCalls, channelRef: unknown): ReturnType<typeof runToolStep> {
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
          this.request(row, { type: "approval.requested", kind: "tool", id: call.id, tool: call.name, input: call.input, timeoutAt: this.deployment.clock.now() + snapshot.approvalTimeout }, channelRef);
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
const stepError = (message: string): StepResult => ({ ok: false, error: { code: "unknown", message, retryable: false } });

function resolveProfile(spec: AgentSpec, providers: Record<string, ProviderConfig>): ProviderConfig | undefined {
  const name = spec.model.providerProfile ?? (Object.keys(providers).length === 1 ? Object.keys(providers)[0] : undefined);
  return name === undefined ? undefined : providers[name];
}

/** A grant lifts each bound it names and leaves the others open; the Scope ceiling caps all of them. */
function resolveBudget(grant: Capabilities["longRunning"], ceiling: Ceilings["longRunning"]): TurnBudget {
  const budget: TurnBudget = grant ? { steps: grant.maxSteps ?? UNBOUNDED, wallMs: grant.maxWallMs ?? UNBOUNDED, tokens: grant.maxTokens ?? UNBOUNDED } : { ...DEFAULT_BUDGET };
  if (ceiling) {
    budget.steps = Math.min(budget.steps, ceiling.maxSteps ?? UNBOUNDED);
    budget.wallMs = Math.min(budget.wallMs, ceiling.maxWallMs ?? UNBOUNDED);
    budget.tokens = Math.min(budget.tokens, ceiling.maxTokens ?? UNBOUNDED);
  }
  return budget;
}

function exhausted(used: BudgetUsed, max: TurnBudget): boolean {
  return used.steps >= max.steps || used.wallMs >= max.wallMs || used.tokens >= max.tokens;
}

function addUsage(total: Usage, usage: Usage): Usage {
  return { input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite };
}
