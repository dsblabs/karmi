import { providerOutput, restoreProviderTool } from "./provider-output";
import { offeredProviderTools, resolveProviderTools } from "./provider-tools";
import { isMediaRef } from "./context";
import { truncateOutput, renderTruncated } from "./spill";
import { DEFAULT_ANNOTATIONS } from "./tool";
import { readScriptResult } from "./script-results";
import { CloudflareIsolateSandbox } from "./isolate-sandbox";
import { scriptTool, resolveScriptLimits } from "./scripts";
import type { ScriptLimits } from "./sandbox";
import {
  DelegationStore,
  delegateTool,
  delegationError,
  delegationResult,
  delegationDeadline,
  depthLimit,
  resolveDelegationLimits,
  type DelegateInput,
  type Ancestor,
  type ChildOrigin,
  type DelegationRecord,
} from "./delegation";
import type { ToolResult } from "./tool";
import {
  API_LIMITS,
  overLimit as overScheduleLimit,
  resolveSchedule,
  resolveSchedulingLimits,
  ScheduleStore,
  scheduleJobId,
  schedulingTools,
  summarise,
  type ScheduleFailure,
  type ScheduleRecord,
  type ScheduleRequest,
  type ScheduleSummary,
  type SchedulingLimits,
} from "./schedule";
import { nextCronTime } from "./cron";
import { mediaAccess, putMedia, type MediaBody, type MediaOptions } from "./media";
import { chooseProfile, resolveScopeConfig, type ScopeConfigDocument } from "./scope-config";
import type { MediaRef } from "./context";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import type { AgentSpec, Capabilities, PolicyRule } from "./agent";
import type { KarmiBindings } from "./bindings";
import { activateSkill, builtInTools, memoryTools, type BuiltInHost, type MemoryHost } from "./builtins";
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
} from "./compaction";
import type { Logger } from "./context";
import type { FragmentContext } from "./fragment";
import { foldLoaded, type Loaded } from "./loading";
import { deliveryBinding, type DeliveryBinding } from "./deliverer";
import type { Deployment } from "./deployment";
import { errorMessage, KarmiError } from "./errors";
import type { Compacted, HookContextBase, HookContexts, HookResults, TurnEnd } from "./hook";
import { hooksAt } from "./hooks";
import { keys } from "./keys";
import { bindLogger } from "./logger";
import { sha256Hex } from "./digest";
import { parseMcpReference } from "./mcp-catalog";
import { McpRegistry, type McpServerSnapshot } from "./mcp-registry";
import { McpTurnSource, type ConnectRequest } from "./mcp-source";
import { fail, ok, remote, unwrap, type Outcome } from "./outcome";
import { isPlatformFailure } from "./platform-failure";
import { evaluatePrompt } from "./prompt";
import { MEMORY_FRAGMENT_NOTES, notesEnabled, renderMemory, type MemoryConfig } from "./memory";
import type { MemoryDurableObject } from "./memory-do";
import type { ContentBlock, ProviderError, ProviderEvent, ProviderRequest, StopReason, Usage } from "./provider";
import { prepareMessages, providerReplayKey } from "./replay";
import { ScheduledDurableObject, type ScheduledJob } from "./scheduler";
import { providerHosts, scopedFetch } from "./scoped-fetch";
import type { ConnectOutcome, ScopeConfigDurableObject, ScopeState, TurnSnapshotSource } from "./scope-config-do";
import {
  attemptTarget,
  fallbackReason,
  resolveProfileCredentials,
  type FallbackEngaged,
  type FallbackReason,
  type ProviderCredentials,
} from "./secrets";
import type { Ceilings, McpServerConfig, ProviderConfig } from "./scope-config";
import type {
  ApprovalAnswer,
  ApprovalSource,
  Budget,
  CompactionTrigger,
  Granularity,
  PauseReason,
  ResumeReason,
  StepCredentials,
  ThreadEvent,
  ThreadEventData,
  ThreadEventType,
  UsageRecordData,
  TurnInput,
} from "./thread-events";
import {
  encodeKey,
  titleOf,
  type CompactOptions,
  type PendingApproval,
  type ThreadAddress,
  type ThreadStatus,
} from "./thread";
import { runToolStep, type PriorCalls, type ToolCall } from "./tool-step";
import { foldTurn, type Plan, type Request, type TurnState } from "./turn-state";
import { resolveToolSet, toolDefinitions, toolsInContext, unloadedDeferred, type ToolSet } from "./tools";
import { splitModelId, transcriptFromEvents } from "./transcript";
import type { QueueMessage } from "./queue";
import type { UsageAttribution, UsageRecord } from "./usage";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS deleted (id INTEGER PRIMARY KEY CHECK (id = 1));
  CREATE TABLE IF NOT EXISTS thread (scope_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, attempt INTEGER NOT NULL, recoveries INTEGER NOT NULL, agent_version INTEGER, snapshot_json TEXT, usage_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS provider_tool_calls ON events (turn) WHERE type = 'server_tool.called';
  CREATE INDEX IF NOT EXISTS events_turn_seq ON events (turn, seq);
  CREATE TABLE IF NOT EXISTS delivery_route (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deliveries (to_seq INTEGER PRIMARY KEY, from_seq INTEGER NOT NULL, turn INTEGER NOT NULL, binding_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS deliveries_turn ON deliveries (turn, to_seq);
  CREATE TABLE IF NOT EXISTS inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS usage_outbox (seq INTEGER PRIMARY KEY);
`;

/** The largest Turn snapshot, in bytes of JSON, a Thread stores. A Spec that produces a larger one is rejected. */
export const SNAPSHOT_LIMIT = 256 * 1024;
const MAX_STEP_ATTEMPTS = 3;
const POLL_TIMEOUT_MS = 15_000;
const POLL_LIMIT = 256;
/** How many Usage records one Queue message carries at most. */
const USAGE_BATCH = 100;
/** How long a Step may run without progress before the alarm presumes it lost and re-enters the loop. */
const STEP_WATCHDOG_MS = 60_000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What a Turn may spend before asking to continue, when the Agent has no `longRunning` grant. */
export const DEFAULT_BUDGET: Readonly<Budget> = Object.freeze({ steps: 25, wallMs: 10 * 60_000, tokens: 500_000 });
/** The value of a `longRunning` bound the Spec leaves out. It stands in for Infinity, which JSON cannot store. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const CANCELLED = Symbol("cancelled");

/**
 * The resolved Scope and Agent configuration one Turn runs under. It is persisted in the Thread at the Turn's
 * first Step, so a Spec change takes effect on the next Turn.
 */
export interface TurnSnapshot {
  /** The `scripts` Capability under the Scope ceiling. Absent without the grant. */
  scripts?: ScriptLimits;
  /** The Provider Tool grant bounded by Scope ceilings. */
  providerTools?: Capabilities["providerTools"];
  /** The Scope's media limits. */
  media?: ScopeConfigDocument["media"];
  agentVersion: number;
  /** The Agent Spec, normalised. A JSON round trip has dropped every explicit `undefined`. */
  spec: AgentSpec;
  /** The chosen Provider profile without its credential. */
  profile: ProviderConfig;
  profileName: string;
  /** The Deployment profile the chosen one falls back to, and on which reasons. Absent without opt-in. */
  fallback?: { name: string; profile: ProviderConfig; on: FallbackReason[] };
  /** The Permission Policy rules in order: the Scope's, then the Deployment's, then the Spec's own. */
  policy: PolicyRule[];
  /** The Spec's `approvals.timeout` under the Scope ceiling, in milliseconds. */
  approvalTimeout: number;
  /** The `longRunning` grant under the Scope ceiling, or `DEFAULT_BUDGET` without one. */
  budget: Budget;
  /** The `delegation` grant under the Scope ceiling. Absent without the grant. */
  delegation?: NonNullable<Capabilities["delegation"]>;
  /** The `scheduling` grant under the Scope ceiling and the Deployment caps. Absent without the grant. */
  scheduling?: SchedulingLimits;
  /** The Spec's `context` with the Framework defaults filled in. `window` is absent when the model's own applies. */
  context: { window?: number; windowCeiling?: number; reserveTokens: number; keepRecentTokens: number };
  /**
   * The MCP servers the Spec references, as registered, and the egress globs they run under. Absent when the
   * Spec references none.
   */
  mcp?: { servers: Record<string, McpServerConfig>; hosts?: string[] };
}

/** What `prepare` works out before a Turn starts: its snapshot, when the Scope answered, and its Tool sources. */
interface PreparedTurn {
  snapshot?: TurnSnapshot;
  mcp?: McpTurnSource;
  /** A fingerprint of the whole Tool set the Turn runs with. */
  toolsVersion: string;
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
  /** A `FallbackEngaged` once a model Step of this Turn has fallen back after a Provider error. */
  fallback_json: string | null;
  usage_json: string;
};

type EventRow = { seq: number; turn: number; at: number; type: ThreadEventType; json: string };

/**
 * What one model call runs under: the profile, its credentials for this call only, and what `step.started`
 * records about them.
 */
interface StepCall {
  profile: ProviderConfig;
  credentials: ProviderCredentials;
  started: StepCredentials;
}

/** The outcome of one model Step attempt: the Provider finished, or it failed and the next fallback should try. */
type StepResult = { ok: true; stopReason: StopReason; message: ContentBlock[] } | { ok: false; error: ProviderError };

/**
 * An `approval.requested` before its `timeoutAt` is stamped. The type is distributive so each kind keeps its
 * own fields.
 */
type ApprovalRequest =
  Extract<ThreadEventData, { type: "approval.requested" }> extends infer E
    ? E extends { timeoutAt: number }
      ? Omit<E, "timeoutAt">
      : never
    : never;

type ModelPlan = Extract<Plan, { kind: "model" }>;
type ToolPlan = Extract<Plan, { kind: "tool" }>;
/**
 * How a compact Step ended: with a `thread.compacted`, or called off because nothing could be dropped or a
 * Hook said `skip`.
 */
type CompactResult = "compacted" | "skipped";
type Summary = Pick<Compacted, "strategy" | "summary" | "raw" | "usage">;
/** The events the next model call is built from, and the `seq` a new Compaction cut must stay above. */
type ContextLog = { events: ThreadEvent[]; floor: number };
/** Whether the Turn loop goes on after a helper, or the helper already ended or parked the Turn. */
type Next = "continue" | "stop";

// These are the only decode points for the JSON columns this Durable Object writes. The rows are its own,
// so the shapes are trusted. A shape change handles old rows here.
const decodeUsage = (json: string): Usage => JSON.parse(json);
// Older snapshots carry no `context` and run under the defaults.
const decodeSnapshot = (json: string): TurnSnapshot => ({ context: resolveContext({}, {}), ...JSON.parse(json) });
const decodeBinding = (json: string): DeliveryBinding => JSON.parse(json);
const decodeEvent = (json: string): ThreadEventData => JSON.parse(json);
const decodeInput = (json: string): TurnInput => JSON.parse(json);

/**
 * The Durable Object that owns one Thread: its event log, inputs, Schedules and Delegations. It drives every
 * Turn itself. The Worker reaches it through `openThread`, and a Deployment subclasses it to supply the
 * `deployment`.
 */
export abstract class ThreadDurableObject extends ScheduledDurableObject {
  abstract readonly deployment: Deployment;

  private readonly delegations: DelegationStore;
  private readonly scheduleStore: ScheduleStore;
  private syncWork: Promise<void> | undefined;
  private syncAgain = false;
  private head = 0;
  private active = false;
  /** Subscribers waiting on an empty poll. Each append wakes them all. */
  private waiters: (() => void)[] = [];
  /** The root of the Turn's AbortSignal tree. It is aborted when the Turn ends or is cancelled. */
  private turnAbort = new AbortController();
  /** The running Turn's MCP servers, as catalogues and lazily opened sessions. Dropped when the Turn ends. */
  private mcp: { turn: number; source: McpTurnSource | undefined } | undefined;
  // The Memory Fragment is rendered once per Turn so the system prompt stays the same across its Steps, which
  // keeps the Provider's prompt cache valid. A write mid-Turn is visible through `recall` and in the next Turn.
  private memory: { turn: number; text: string | undefined } | undefined;
  /** The Turn whose snapshot and catalogues are being fetched. An input arriving meanwhile is for the Turn after it. */
  private preparing: number | undefined;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    this.delegations = new DelegationStore(ctx.storage.sql);
    this.scheduleStore = new ScheduleStore(ctx.storage.sql);
    const columns = (table: string) =>
      new Set(
        ctx.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .map((column) => column.name),
      );
    if (!columns("thread").has("platform_failure")) {
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN platform_failure INTEGER NOT NULL DEFAULT 0");
      // A Thread written before the jobs table existed has no watchdog row, so a running Turn gets one here.
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO jobs (id, kind, dueAt, payload, attempt, generation) SELECT 'watchdog', 'watchdog', 0, 'null', 0, ? FROM thread WHERE state = 'running'",
        crypto.randomUUID(),
      );
    }
    if (!columns("thread").has("cancelled"))
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0");
    if (!columns("inputs").has("steer"))
      ctx.storage.sql.exec("ALTER TABLE inputs ADD COLUMN steer INTEGER NOT NULL DEFAULT 0");
    if (!columns("thread").has("fallback_json"))
      ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN fallback_json TEXT");
    this.head = ctx.storage.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").one().seq ?? 0;
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Every entry point passes through here. An address with `create` makes the Thread on first touch, one
  // without never does, and a Thread answers only to the identity it was created with.
  private enter(address: ThreadAddress): Outcome<ThreadRow> {
    if (this.sql.exec("SELECT id FROM deleted").toArray().length)
      return fail(new KarmiError("thread.deleted", "This Thread has been deleted."));
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
        fallback_json: null,
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

  async upload(address: ThreadAddress, body: MediaBody, options: MediaOptions): Promise<Outcome<MediaRef>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const config = await this.scopeStub(entered.value).configGet(address.scope);
    if (!config.ok) return config;
    const limits = resolveScopeConfig(this.deployment.defaults, config.value.document).media;
    try {
      const ref = await putMedia(
        { bucket: this.env.KARMI_MEDIA, scope: address.scope, threadId: address.threadId, limits },
        body,
        options,
      );
      if (this.sql.exec("SELECT id FROM deleted").toArray().length) {
        await this.env.KARMI_MEDIA?.delete(ref.key);
        return fail(new KarmiError("thread.deleted", "This Thread has been deleted."));
      }
      return ok(ref);
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
  }

  delete(address: ThreadAddress): Outcome<void> {
    if (this.sql.exec("SELECT id FROM deleted").toArray().length) return ok(undefined);
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    this.sql.exec("INSERT INTO deleted (id) VALUES (1)");
    this.turnAbort.abort();
    this.sql.exec("DELETE FROM jobs");
    this.scheduler.set({
      id: "thread-cleanup",
      kind: "thread-cleanup",
      dueAt: this.deployment.clock.now(),
      payload: address,
    });
    for (const wake of this.waiters.splice(0)) wake();
    return ok(undefined);
  }

  private async cleanup(address: ThreadAddress): Promise<void> {
    if (this.active) {
      this.scheduler.set({
        id: "thread-cleanup",
        kind: "thread-cleanup",
        dueAt: this.deployment.clock.now() + 1000,
        payload: address,
      });
      return;
    }
    const bucket = this.env.KARMI_MEDIA;
    if (bucket)
      for (const prefix of keys.threadObjects(address.scope, address.threadId)) {
        const batch = await bucket.list({ prefix, limit: 100 });
        if (batch.objects.length) {
          await bucket.delete(batch.objects.map((object) => object.key));
          this.scheduler.set({
            id: "thread-cleanup",
            kind: "thread-cleanup",
            dueAt: this.deployment.clock.now(),
            payload: address,
          });
          return;
        }
      }
    const forgotten = await remote<ScopeConfigDurableObject>(
      this.env.KARMI_SCOPES,
      keys.config(address.scope),
    ).threadForget(address.scope, address.threadId);
    if (!forgotten.ok) throw new KarmiError(forgotten.code, forgotten.message);
    this.ctx.storage.transactionSync(() => {
      for (const table of [
        "thread",
        "events",
        "inputs",
        "deliveries",
        "delivery_route",
        "jobs",
        "delegation_origin",
        "delegation_children",
        "delegation_reservations",
        "schedules",
      ])
        this.sql.exec(`DELETE FROM ${table}`);
    });
    this.head = 0;
  }

  private media(row: ThreadRow, limits?: ScopeConfigDocument["media"]) {
    const signal = this.turnAbort.signal;
    return mediaAccess(this.env.KARMI_MEDIA, row.scope_id, {
      put: (body, options) =>
        putMedia(
          { bucket: this.env.KARMI_MEDIA, scope: row.scope_id, threadId: row.thread_id, limits, signal },
          body,
          options,
        ),
    });
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
    const { turn } = this.enqueue(row, input, steer);
    return ok({ turn, seq: this.head });
  }

  /** Queues one input and wakes the loop. Returns the Turn it will run in and its `inputs` row id. */
  private enqueue(row: ThreadRow, input: TurnInput, steer: boolean): { turn: number; id: number } {
    // A steer joins the Turn in flight. Anything else coalesces into the one next Turn, which is the one
    // after the Turn being prepared right now.
    const joins = steer && row.state !== "idle";
    const next = this.preparing === undefined ? row.turn + 1 : this.preparing + 1;
    const { id } = this.sql
      .exec<{ id: number }>(
        "INSERT INTO inputs (turn, json, steer) VALUES (?, ?, ?) RETURNING id",
        joins ? row.turn : next,
        JSON.stringify(input),
        joins ? 1 : 0,
      )
      .one();
    if (this.active) this.armWatchdog();
    else if (row.state === "idle" || row.state === "running") this.kick(row.state === "running");
    else if (!joins && this.readTurn(row).paused === "scope_suspended") this.wake(row, "input");
    return { turn: joins ? row.turn : next, id };
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
    const origin = this.delegations.origin();
    const status: ThreadStatus = {
      state: row.state,
      ...(origin && { parent: origin.parent }),
      ...(row.agent_version !== null && { agentVersion: row.agent_version }),
      usage: decodeUsage(row.usage_json),
      seq: this.head,
    };
    const nextScheduleAt = this.scheduleStore.nextAt();
    if (nextScheduleAt !== undefined) status.nextScheduleAt = nextScheduleAt;
    if (row.state === "idle") return ok(status);
    const turn = this.readTurn(row);
    status.turn = row.turn;
    status.step = row.step;
    if (turn.paused) status.paused = turn.paused;
    if (row.snapshot_json !== null) {
      const snapshot = decodeSnapshot(row.snapshot_json);
      status.budget = {
        ...turn.budget,
        max: snapshot.budget,
        ...(snapshot.spec.capabilities?.delegation && { delegated: this.delegations.budget(row.turn) }),
      };
    }
    const pending: PendingApproval[] = [];
    for (const [seq, request] of turn.requests)
      if (!request.answered)
        pending.push({
          seq,
          kind: request.kind,
          ...(request.kind !== "continue" && { tool: request.tool }),
          ...(request.kind === "connect" && { serverId: request.serverId, authUrl: request.authUrl }),
          timeoutAt: request.timeoutAt,
          ...(request.child && { child: request.child }),
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
    // A request of a finished Turn was already answered, timed out, or cancelled with that Turn.
    const request =
      row.state === "idle" || requested.turn !== row.turn ? undefined : this.readTurn(row).requests.get(seq);
    if (!request || request.answered)
      return fail(new KarmiError("approval.resolved", `The Approval at seq ${seq} has already been answered.`));
    if (answer.decision !== "allow" && answer.decision !== "deny")
      return fail(new KarmiError("approval.invalid", `An Approval answer is "allow" or "deny".`));
    // Only completing OAuth can grant a Connection. A hand-written allow would retry a call that still has
    // no token.
    if (request.kind === "connect" && answer.decision === "allow")
      return fail(
        new KarmiError(
          "approval.invalid",
          `A connect Approval is granted by completing OAuth at its authUrl; only "deny" can be answered here.`,
        ),
      );
    if (request.child) return this.forwardApproval(row, seq, request, answer);
    this.resolve(row, seq, request, answer, "answer");
    await this.settle(row);
    return ok(undefined);
  }

  private async forwardApproval(
    row: ThreadRow,
    seq: number,
    request: Request,
    answer: ApprovalAnswer,
  ): Promise<Outcome<void>> {
    const child = this.delegations.children(row.turn).find((c) => c.address.threadId === request.child?.threadId);
    if (!child || !request.child) return fail(new KarmiError("approval.notFound", "Child Thread not found."));
    const forwarded = await this.threadStub(child.address).approve(child.address, request.child.seq, answer);
    if (!forwarded.ok) return forwarded;
    const current = this.row();
    if (current.turn !== row.turn || current.state === "idle") return ok(undefined);
    const pending = this.readTurn(current).requests.get(seq);
    // The child owns remembered grants. The parent only records the answer.
    if (pending && !pending.answered) this.resolve(current, seq, pending, { ...answer, remember: false }, "answer");
    await this.settle(current);
    return ok(undefined);
  }

  /**
   * Answers the `connect` requests for `serverId` from the OAuth callback. A grant retries the call. Anything
   * else refuses it.
   */
  async connected(address: ThreadAddress, serverId: string, outcome: ConnectOutcome): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (row.state !== "parked") return ok(undefined);
    const turn = this.readTurn(row);
    for (const [seq, request] of turn.requests) {
      if (request.kind !== "connect" || request.answered || request.serverId !== serverId) continue;
      const answer: ApprovalAnswer = outcome.granted
        ? { decision: "allow", by: "oauth" }
        : { decision: "deny", by: "oauth", reason: outcome.reason };
      this.resolve(row, seq, request, answer, "answer");
    }
    await this.settle(row);
    return ok(undefined);
  }

  async cancel(address: ThreadAddress): Promise<Outcome<void>> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const row = entered.value;
    if (row.state === "idle") return ok(undefined);
    if (this.active) {
      // The loop owns the Turn. It notices the abort at once, or as soon as the park's Hooks return, and
      // ends the Turn itself.
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
    // The snapshot is dropped so the Turn goes on under the Scope's current configuration.
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

  /**
   * Runs a Compaction outside any Turn. The Thread must be idle, and a `send` sees it as busy until the
   * Compaction is done.
   */
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
      const context = this.contextLog();
      const result = await this.compactStep(
        row,
        boundary.snapshot,
        n,
        "manual",
        options.instructions,
        context,
        undefined,
      );
      return result.ok ? ok(undefined) : result;
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
    const event: ThreadEvent = { ...body, seq, turn, at };
    this.sql.exec(
      "INSERT INTO events (seq, turn, at, type, json) VALUES (?, ?, ?, ?, ?)",
      seq,
      turn,
      at,
      data.type,
      JSON.stringify(body),
    );
    // A record is queued for the UsageHandler in the same write as the event, so an eviction never loses
    // one. Without a handler or a Queue the record only stays in the log.
    if (data.type === "usage.recorded" && this.deployment.catalogue.usageHandler && this.env.KARMI_QUEUE) {
      this.sql.exec("INSERT INTO usage_outbox (seq) VALUES (?)", seq);
      this.scheduleUsageFlush(at);
    }
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
        // The delivery is due a second later so a live subscriber can acknowledge the event first. The Queue
        // checks again before delivering.
        this.scheduler.set({ id: `delivery:${seq}`, kind: "delivery", dueAt: at + 1000, payload: { toSeq: seq } });
      }
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    if (
      data.type === "approval.requested" ||
      data.type === "approval.resolved" ||
      data.type === "turn.completed" ||
      data.type === "turn.failed"
    )
      this.scheduleParentNotification();
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
    // The loop is not awaited. The Durable Object outlives the caller's request, and it is the persisted rows,
    // not `waitUntil`, that survive an eviction.
    void this.run(recovering).catch((error: unknown) => {
      this.deployment.logger.error("Thread loop interrupted", { error: errorMessage(error) });
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
    if (job.kind === "thread-cleanup") return this.cleanup(decodeCleanup(job.payload));
    if (this.sql.exec("SELECT id FROM deleted").toArray().length) return;
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
    if (job.kind === "usage") return this.flushUsage();
    if (job.kind === "delegation") return this.syncDelegations();
    if (job.kind === "delegation-notify") return this.notifyParent();
    if (job.kind === "delegation-deadline") {
      const row = this.row();
      if (row.state !== "idle") await this.cancel(this.address(row));
      return;
    }
    if (job.kind === "park-timeout") return this.expire(job.payload as { seq: number });
    if (job.kind === "schedule") return this.fireSchedule(decodeScheduleJob(job.payload));
    if (job.kind !== "watchdog") return super.runJob(job);
    const row = this.sql.exec<ThreadRow>("SELECT * FROM thread").toArray()[0];
    if (!row || row.state === "parked" || (row.state === "idle" && !this.hasInputs())) {
      this.scheduler.cancel("watchdog");
      return;
    }
    // While an invocation is still running the Step, the alarm only re-arms itself as a heartbeat.
    if (this.active) this.armWatchdog();
    else this.kick(row.state === "running");
  }

  // The Turn loop. One instance runs at a time, driven by `send`, the watchdog alarm and the answers that
  // wake a parked Turn. It resumes whatever the row says is in flight, then drains queued inputs.
  private async run(recovering: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (;;) {
        if (this.sql.exec("SELECT id FROM deleted").toArray().length) return;
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
          if (!(await this.startNextTurn(row))) {
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
        // A parked Turn or a platform failure waits for its answer or the watchdog rather than spinning
        // here. An answer or cancel that landed during the park's Hooks is picked up by the next iteration.
        const after = this.row();
        if (after.platform_failure || (after.state === "parked" && !after.cancelled)) return;
      }
    } finally {
      this.active = false;
    }
  }

  /**
   * Gathers what a Turn needs before its first event: the Scope snapshot and the MCP catalogues, refreshed
   * when stale, so `turn.started` can carry the version of the whole Tool set. When the Scope refuses, the
   * snapshot is left out. The first Step then asks again and ends the Turn with the reason.
   */
  private async prepare(row: ThreadRow): Promise<PreparedTurn> {
    const fingerprint = await this.deployment.catalogue.fingerprint();
    const turn = row.turn + 1;
    const first = this.sql.exec<{ json: string }>("SELECT json FROM inputs ORDER BY id LIMIT 1").toArray()[0];
    const source = await this.scopeSnapshot({ ...row, turn }, first ? decodeInput(first.json) : undefined);
    if (!source.ok) return { toolsVersion: fingerprint };
    const mcp = await this.openMcp({ ...row, turn }, source.snapshot);
    const versions = mcp?.versions() ?? {};
    const toolsVersion =
      Object.keys(versions).length === 0 ? fingerprint : await sha256Hex(JSON.stringify([fingerprint, versions]));
    return { snapshot: source.snapshot, ...(mcp && { mcp }), toolsVersion };
  }

  /** Prepares and starts the next Turn from the queued inputs. Returns false when nothing is queued. */
  private async startNextTurn(row: ThreadRow): Promise<boolean> {
    if (!this.hasInputs()) return false;
    // The new Turn's signal tree starts here so the catalogue refreshes in `prepare` run under it.
    this.turnAbort = new AbortController();
    this.preparing = row.turn + 1;
    try {
      return this.startTurn(row, await this.prepare(row));
    } finally {
      this.preparing = undefined;
    }
  }

  private startTurn(row: ThreadRow, prepared: PreparedTurn): boolean {
    const turn = row.turn + 1;
    // Nothing may yield between taking the inputs and logging them, or an eviction would lose them.
    const queued = this.sql
      .exec<{ json: string }>("SELECT json FROM inputs WHERE turn <= ? ORDER BY id", turn)
      .toArray();
    const [first, ...rest] = queued.map((next) => decodeInput(next.json));
    if (!first) return false;
    this.sql.exec("DELETE FROM inputs WHERE turn <= ?", turn);
    this.update({
      state: "running",
      turn,
      step: 0,
      attempt: 0,
      recoveries: 0,
      platform_failure: 0,
      cancelled: 0,
      snapshot_json: prepared.snapshot ? JSON.stringify(prepared.snapshot) : null,
      agent_version: prepared.snapshot?.agentVersion ?? null,
      fallback_json: null,
    });
    this.mcp = { turn, source: prepared.mcp };
    this.append(turn, { type: "turn.started", input: first, toolsVersion: prepared.toolsVersion }, first.channelRef);
    for (const input of rest) this.append(turn, { type: "turn.input", input }, first.channelRef);
    return true;
  }

  /** Counts an interrupted Step's recovery. Fails the Turn and returns `stop` when the Step has no attempts left. */
  private async recover(row: ThreadRow): Promise<Next> {
    const plan = this.readTurn(row).plan;
    if (isRerun(plan)) {
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

  /** Brings a parked Turn back to running. The loop is kicked unless the caller is the loop. */
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
        fallback_json: null,
      });
    if (end.type !== "turn.paused") this.scheduler.cancel("delegation-deadline");
    if (end.type !== "turn.paused" && this.hasInputs()) this.armWatchdog();
    else this.scheduler.cancel("watchdog");
    // The row no longer holds the snapshot, so it is read from the copy taken on entry. A Turn that never
    // took one has no Hooks to run.
    const snapshot = row.snapshot_json === null ? undefined : decodeSnapshot(row.snapshot_json);
    if (snapshot) {
      if (end.type === "turn.failed")
        await this.turnHooks(row, snapshot, "on-error", { error: { code: end.reason, message: end.message } });
      await this.turnHooks(row, snapshot, "after-turn", { end });
    }
    this.turnAbort.abort();
    // MCP sessions never outlive the Turn, parked or not. A woken Turn opens fresh ones from the cached
    // catalogues.
    const mcp = this.mcp;
    this.mcp = undefined;
    await mcp?.source?.close();
    await this.syncDelegations();
  }

  // Approvals are one request per asked call or per exhausted budget, answered once by a human, a timeout
  // or a cancel. Answering is one append, and `settle` decides whether the Turn goes on.
  /** Appends an `approval.requested` event and arms its timeout. `timeoutAt` is measured from the event's own `at`. */
  private request(row: ThreadRow, snapshot: TurnSnapshot, data: ApprovalRequest, channelRef: unknown): void {
    const at = this.deployment.clock.now();
    const timeoutAt = at + snapshot.approvalTimeout;
    const { seq } = this.append(row.turn, { ...data, timeoutAt }, channelRef, at);
    this.scheduler.set({ id: `park-timeout:${seq}`, kind: "park-timeout", dueAt: timeoutAt, payload: { seq } });
  }

  private resolve(row: ThreadRow, seq: number, request: Request, answer: ApprovalAnswer, source: ApprovalSource): void {
    const remember =
      answer.remember === true && answer.decision === "allow" && request.kind === "tool" && !request.child;
    this.append(
      row.turn,
      {
        type: "approval.resolved",
        request: seq,
        kind: request.kind,
        ...(request.kind !== "continue" && { tool: request.tool }),
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

  /**
   * Continues a parked Turn that has nothing left to wait for, or ends it when a `continue` was refused. Called
   * after an answer or a Job outcome.
   */
  private async settle(row: ThreadRow): Promise<void> {
    if (this.row().state !== "parked") return;
    const turn = this.readTurn(row);
    if (this.waiting(turn) !== undefined) return;
    // An allowed `continue` leaves no request behind, so any `continue` still here was refused.
    for (const request of turn.requests.values()) {
      if (request.kind !== "continue" || request.child) continue;
      await this.finish(this.row(), { type: "turn.completed", stopReason: "budget", message: turn.lastMessage });
      this.kickIfQueued();
      return;
    }
    this.wake(row, turn.paused === "job" ? "job" : "approval");
  }

  private async cancelTurn(row: ThreadRow): Promise<void> {
    this.update({ cancelled: 1 });
    await Promise.all(
      this.delegations
        .children(row.turn)
        .filter((child) => !child.done)
        .map((child) => this.stopChild(child)),
    );
    const turn = this.readTurn(row);
    for (const [seq, request] of turn.requests)
      if (!request.answered) this.resolve(row, seq, request, { decision: "deny" }, "cancel");
    for (const job of turn.jobs.values())
      if (!job.outcome)
        this.append(row.turn, { type: "job.cancelled", jobId: job.jobId }, this.turnInput(row.turn)?.channelRef);
    this.turnAbort.abort();
    await this.finish(this.row(), failure("cancelled", "The Turn was cancelled."));
  }

  // This runs one Turn from wherever the log says it stands. Model Steps and tool Steps alternate until a
  // model Step ends without tool calls. On a model Step, `attempt` indexes the fallback list, so an
  // eviction re-runs the same model and only a Provider failure rotates. On a tool Step it counts recoveries.
  private async turn(row: ThreadRow): Promise<void> {
    if (this.turnAbort.signal.aborted) this.turnAbort = new AbortController();
    try {
      await this.steps(row);
    } catch (caught) {
      if (isPlatformFailure(caught)) {
        this.update({ platform_failure: 1 });
        this.turnAbort.abort();
        this.armWatchdog();
        return;
      }
      // Anything else is a bug, not an eviction, so the Turn ends as failed instead of waiting for the
      // watchdog to re-run it.
      await this.finish(this.row(), failure("internal", errorMessage(caught)));
    }
  }

  private async steps(row: ThreadRow): Promise<void> {
    const channelRef = this.turnInput(row.turn)?.channelRef;
    const available = this.toolSet(row, channelRef);
    for (;;) {
      const boundary = await this.snapshot(row);
      if (this.row().cancelled) return this.cancelTurn(this.row());
      if (!boundary.ok) return this.finish(this.row(), boundary.failure);
      const { snapshot } = boundary;
      if (row.step === 0) {
        if ((await this.beforeTurn(row, snapshot)) === "stop") return;
        if ((await this.activateCommand(row, snapshot, await available(snapshot), channelRef)) === "stop") return;
      }
      const turn = this.joinSteers(row, this.readTurn(row), channelRef);
      const { plan } = turn;
      if (plan.kind === "finish")
        return this.finish(this.row(), { type: "turn.completed", stopReason: plan.stopReason, message: plan.message });
      if (plan.kind !== "compact" && plan.fresh && exhausted(turn.budget, snapshot.budget))
        return this.parkOnBudget(row, snapshot, turn, channelRef);
      let next: Next;
      // The context log is read once here and handed down, because the boundary check and the Step both
      // use it.
      const context = plan.kind === "model" && plan.fresh ? this.contextLog() : undefined;
      const limits = this.limits(snapshot);
      if (plan.kind === "compact")
        next = await this.runCompactStep(row, snapshot, plan.n, plan.trigger, this.contextLog(), channelRef);
      else if (context && turn.compaction === undefined && overLimit(contextTokens(context.events), limits))
        next = await this.runCompactStep(row, snapshot, plan.n, "auto", context, channelRef);
      else if (plan.kind === "model")
        next = await this.startModelStep(row, snapshot, plan, await available(snapshot), channelRef, turn, context);
      else next = await this.startToolStep(row, snapshot, plan, await available(snapshot), channelRef);
      if (next === "stop") return;
      row = this.row();
    }
  }

  /**
   * Builds the resolver for one Step's Tool set: the snapshot's references under the Thread's remembered
   * allows and what the context has loaded so far. It is resolved per Step, since a Step may load Tools
   * for the next one.
   */
  private toolSet(row: ThreadRow, channelRef: unknown): (snapshot: TurnSnapshot) => Promise<ToolSet> {
    return async (snapshot) => {
      const mcp = await this.mcpSource(row, snapshot);
      let set: ToolSet | undefined;
      const current = (): ToolSet => {
        if (!set) throw new Error("A built-in Tool ran before its Tool set was resolved.");
        return set;
      };
      const host: BuiltInHost = {
        scope: row.scope_id,
        threadId: row.thread_id,
        bucket: this.env.KARMI_MEDIA,

        tools: current,
        fragmentContext: () => this.fragmentContext(row, snapshot, current()),
        append: (data) => void this.append(row.turn, data, channelRef),
      };
      set = resolveToolSet({
        spec: snapshot.spec,
        catalogue: this.deployment.catalogue,
        policy: snapshot.policy,
        builtIns: [
          ...builtInTools(host),
          ...(snapshot.scripts && this.env.KARMI_LOADER
            ? [scriptTool(snapshot.spec, () => current().available, row.user_id ?? undefined)]
            : []),
          ...(snapshot.spec.capabilities?.delegation
            ? [
                delegateTool(snapshot.spec.delegates ?? [], (input, callId) =>
                  this.delegate(row, snapshot, input, callId),
                ),
              ]
            : []),
          ...(snapshot.scheduling ? schedulingTools(this.schedulingHost(row, snapshot.scheduling, channelRef)) : []),
          ...(snapshot.spec.memory ? memoryTools(this.memoryHost(row, snapshot.spec.memory)) : []),
        ],
        remembered: this.remembered(),
        ...(mcp && { mcp }),
        loaded: this.loaded(),
        window: this.limits(snapshot).window,
      });
      return set;
    };
  }

  /**
   * Returns this Turn's MCP source, opened once per Turn. A recovered or resumed Turn rebuilds it from the
   * cached catalogues.
   */
  private async mcpSource(row: ThreadRow, snapshot: TurnSnapshot): Promise<McpTurnSource | undefined> {
    if (this.mcp?.turn !== row.turn) this.mcp = { turn: row.turn, source: await this.openMcp(row, snapshot) };
    return this.mcp.source;
  }

  private async openMcp(row: ThreadRow, snapshot: TurnSnapshot): Promise<McpTurnSource | undefined> {
    if (!snapshot.mcp) return undefined;
    const registry = new McpRegistry(this.deployment, this.env.KARMI_SCOPES);
    const config: ScopeConfigDocument = {
      mcp: { servers: snapshot.mcp.servers },
      ...(snapshot.mcp.hosts && { egress: { mcpHosts: snapshot.mcp.hosts } }),
    };
    const { servers } = await registry.snapshot(row.scope_id, config, {
      agent: row.agent_id,
      ...(row.user_id !== null && { user: row.user_id }),
    });
    const missing = servers.filter(
      (server): server is McpServerSnapshot & { missing: string } => server.missing !== undefined,
    );
    for (const server of missing)
      this.logger(row).warn("MCP credential missing", { server: server.id, credential: server.missing });
    return McpTurnSource.open(
      {
        scope: row.scope_id,
        registry,
        egress: registry.egress(config, servers),
        logger: this.logger(row),
        signal: this.turnAbort.signal,
      },
      servers,
    );
  }

  /**
   * Builds the context every Fragment of this Turn sees. `model` is the one a model Step names, or the Spec's
   * default.
   */
  private fragmentContext(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    set: ToolSet,
    model = snapshot.spec.model.id,
  ): FragmentContext {
    return {
      model,
      scope: row.scope_id,
      ...(row.user_id !== null && { user: row.user_id }),
      thread: { id: row.thread_id },
      tools: toolsInContext(set).map((tool) => tool.name),
      now: new Date(this.deployment.clock.now()),
    };
  }

  /**
   * Activates the Skill the Turn input names, if any, before the first model Step. Fails the Turn when the
   * Skill is not available.
   */
  private async activateCommand(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    set: ToolSet,
    channelRef: unknown,
  ): Promise<Next> {
    const input = this.turnInput(row.turn);
    if (input?.kind !== "message" || input.skill === undefined) return "continue";
    const name = input.skill;
    // A Skill already active from an earlier Turn, or from before an eviction, is not loaded again.
    if (set.loaded.skills.has(name)) return "continue";
    const entry = set.skills.find((candidate) => candidate.skill.name === name && candidate.invokableBy !== "model");
    if (!entry) {
      const message = `Skill "${name}" cannot be invoked by the User of Agent "${row.agent_id}".`;
      return stop(this.finish(this.row(), failure("skill.unavailable", message)));
    }
    const ctx = this.fragmentContext(row, snapshot, set);
    await activateSkill(entry.skill, ctx, (data) => void this.append(row.turn, data, channelRef), "event");
    return "continue";
  }

  private async beforeTurn(row: ThreadRow, snapshot: TurnSnapshot): Promise<Next> {
    const input = this.turnInput(row.turn);
    const before = input && (await this.turnHooks(row, snapshot, "before-turn", { input }));
    if (this.row().cancelled) return stop(this.cancelTurn(this.row()));
    if (before && !before.ok) return stop(this.finish(this.row(), before.failure));
    return "continue";
  }

  /**
   * Appends queued steer inputs to the Turn at a batch boundary, so they enter the conversation before the
   * next model Step.
   */
  private joinSteers(row: ThreadRow, turn: TurnState, channelRef: unknown): TurnState {
    if (isRerun(turn.plan)) return turn;
    const steers = this.sql.exec<{ json: string }>("SELECT json FROM inputs WHERE steer = 1 ORDER BY id").toArray();
    if (steers.length === 0) return turn;
    this.sql.exec("DELETE FROM inputs WHERE steer = 1");
    for (const next of steers)
      this.append(row.turn, { type: "turn.input", input: decodeInput(next.json), steer: true }, channelRef);
    return this.readTurn(row);
  }

  /**
   * Parks the Turn on its spent budget and asks to continue, unless an unanswered `continue` request already
   * exists.
   */
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
    available: ToolSet,
    channelRef: unknown,
    turn: TurnState,
    context = this.contextLog(),
  ): Promise<Next> {
    const gated = this.modelTarget(row, snapshot, plan);
    if (!gated.ok) return stop(this.finish(this.row(), gated.failure));
    const { modelAttempt, attempt, engaged, target } = gated;
    const { model } = target;
    this.update({ step: plan.n, attempt: modelAttempt, ...(plan.fresh && { recoveries: 0, platform_failure: 0 }) });
    // The credential is resolved for this one call and never written anywhere. Only its source and version
    // are logged.
    const call = await this.stepCredentials(row, snapshot, target.fallback ? engaged : undefined);
    if (!call.ok) return stop(this.finish(this.row(), call.failure));
    this.append(
      row.turn,
      {
        type: "step.started",
        kind: "model",
        n: plan.n,
        attempt,
        model,
        provider: call.profile.adapter,
        agentVersion: snapshot.agentVersion,
        ...call.started,
      },
      channelRef,
    );
    this.armWatchdog();
    const step = this.modelStep({ ...row, step: plan.n }, snapshot, available, model, context.events, channelRef, call);
    const result = await this.untilCancelled(step);
    if (result === CANCELLED) return stop(this.cancelTurn(this.row()));
    const overflow = result.ok
      ? result.stopReason === "context_window_exceeded"
      : result.error.code === "context_window_exceeded";
    if (overflow && turn.compaction !== "skipped") {
      const next = await this.compactOnOverflow(snapshot, plan, context, channelRef);
      if (next !== undefined) return next;
    }
    // The failed attempt stays in the log, because the transcript ignores Steps that never completed. A
    // failure the profile opted to fall back on moves the rest of the Turn to the Deployment profile.
    if (!result.ok) {
      const reason = fallbackReason(result.error.code);
      const engage =
        reason !== undefined && !engaged && !call.started.fallback && snapshot.fallback?.on.includes(reason);
      this.update({
        attempt: modelAttempt + 1,
        ...(engage && { fallback_json: JSON.stringify({ step: plan.n, attempt: modelAttempt, reason }) }),
      });
    }
    return "continue";
  }

  /**
   * Runs a Compaction after a `context_window_exceeded` stop. Returns `continue` when it compacted, `stop`
   * when it failed the Turn, and undefined when nothing could be dropped so the overflow takes its
   * ordinary course as a Provider failure.
   */
  private async compactOnOverflow(
    snapshot: TurnSnapshot,
    plan: ModelPlan,
    context: ContextLog,
    channelRef: unknown,
  ): Promise<Next | undefined> {
    const compacted = await this.compactStep(
      this.row(),
      snapshot,
      plan.n + 1,
      "overflow",
      undefined,
      context,
      channelRef,
    );
    if (!compacted.ok) return stop(this.finish(this.row(), failure("compaction", compacted.message)));
    return compacted.value === "compacted" ? "continue" : undefined;
  }

  /**
   * Works out which model this attempt of a model Step tries and whether it runs on the fallback profile, or
   * why the Step is out of attempts.
   */
  private modelTarget(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    plan: ModelPlan,
  ):
    | {
        ok: true;
        modelAttempt: number;
        attempt: number;
        engaged: FallbackEngaged | undefined;
        target: { model: string; fallback: boolean };
      }
    | { ok: false; failure: TurnEnd } {
    const modelAttempt = plan.fresh ? 1 : Math.max(row.attempt, 1);
    const attempt = modelAttempt + (plan.fresh ? 0 : row.recoveries);
    const engaged = decodeFallback(row.fallback_json);
    const models = [snapshot.spec.model.id, ...(snapshot.spec.model.fallbacks ?? [])];
    const target = attemptTarget(models, engaged, plan.n, modelAttempt);
    if (target === undefined)
      return { ok: false, failure: failure("provider", `Every model of Agent "${row.agent_id}" failed.`) };
    if (attempt > MAX_STEP_ATTEMPTS) {
      const message = `Step ${plan.n} of Turn ${row.turn} exhausted its three attempts.`;
      return { ok: false, failure: failure("recovery", message) };
    }
    return { ok: true, modelAttempt, attempt, engaged, target };
  }

  /**
   * Resolves the profile and credentials one model call runs under. It uses the fallback profile when a
   * Provider error engaged it earlier in the Turn, or right away when the profile's own credential is
   * missing and it opted into `missing`. A credential nobody can resolve fails the Turn rather than
   * spending attempts.
   */
  private async stepCredentials(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    engaged: FallbackEngaged | undefined,
  ): Promise<({ ok: true } & StepCall) | { ok: false; failure: TurnEnd }> {
    const missing = (ref: string) => ({
      ok: false as const,
      failure: failure("credential.missing", `Credential "${ref}" of Agent "${row.agent_id}" is missing or revoked.`),
    });
    const fallback = async (reason: FallbackReason) => {
      // `engaged` only ever holds a reason the snapshot opted into, so the fallback profile is normally
      // present. The check guards a snapshot written by an older version.
      if (!snapshot.fallback)
        return {
          ok: false as const,
          failure: failure("credential.missing", `Agent "${row.agent_id}" has no fallback profile to run on.`),
        };
      const resolved = await resolveProfileCredentials(
        this.deployment.secrets,
        row.scope_id,
        snapshot.fallback.profile,
      );
      if (!resolved.ok) return missing(resolved.missing);
      const started: StepCredentials = {
        profile: snapshot.fallback.name,
        ...(resolved.use && { credential: resolved.use }),
        fallback: { from: snapshot.profileName, reason },
      };
      return { ok: true as const, profile: snapshot.fallback.profile, credentials: resolved.credentials, started };
    };
    if (engaged) return fallback(engaged.reason);
    const resolved = await resolveProfileCredentials(this.deployment.secrets, row.scope_id, snapshot.profile);
    if (!resolved.ok)
      return snapshot.fallback?.on.includes("missing") ? fallback("missing") : missing(resolved.missing);
    const started: StepCredentials = {
      profile: snapshot.profileName,
      ...(resolved.use && { credential: resolved.use }),
    };
    return { ok: true, profile: snapshot.profile, credentials: resolved.credentials, started };
  }

  private async startToolStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    plan: ToolPlan,
    available: ToolSet,
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
    // An answer may have landed while the batch was still running, so the Turn parks only on a wait that
    // is still open.
    const waitsOn = this.waiting(this.readTurn(row));
    if (waitsOn !== undefined) return stop(this.finish(this.row(), { type: "turn.paused", reason: waitsOn }));
    return "continue";
  }

  /** Returns what the current Step still waits on, or undefined when nothing is pending. */
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

  // This is the Step boundary. The first Step takes the Turn snapshot from the Scope and persists it, and
  // every Step checks the Scope is still active.
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
      const taken = await this.scopeSnapshot(row, this.turnInput(row.turn));
      if (!taken.ok) return taken;
      snapshot = taken.snapshot;
      this.update({ snapshot_json: JSON.stringify(snapshot), agent_version: snapshot.agentVersion });
      state = taken.state;
    }
    if (state === "suspended") return { ok: false, failure: { type: "turn.paused", reason: "scope_suspended" } };
    if (state !== "active")
      return { ok: false, failure: failure("scope.destroyed", `Scope "${row.scope_id}" has been destroyed.`) };
    return { ok: true, snapshot };
  }

  /** Asks the Scope for this Turn's snapshot and builds it. Nothing is persisted here. */
  private async scopeSnapshot(
    row: ThreadRow,
    input: TurnInput | undefined,
  ): Promise<{ ok: true; snapshot: TurnSnapshot; state: ScopeState } | { ok: false; failure: TurnEnd }> {
    const title = input ? titleOf(input) : undefined;
    const origin = this.delegations.origin();
    const source = await this.scopeStub(row).turnSnapshot(row.scope_id, row.agent_id, {
      threadId: row.thread_id,
      ...(row.user_id !== null && { userId: row.user_id }),
      ...(origin && { parent: origin.parent }),
      createdAt: row.created_at,
      activeAt: this.deployment.clock.now(),
      ...(title !== undefined && { title }),
    });
    if (!source.ok) return { ok: false, failure: failure(source.code, source.message) };
    const built = buildSnapshot(source.value, this.deployment.defaults.providers ?? {}, row.agent_id);
    if (!built.ok) return built;
    const bytes = new TextEncoder().encode(JSON.stringify(built.snapshot)).byteLength;
    if (bytes > SNAPSHOT_LIMIT)
      return {
        ok: false,
        failure: failure("snapshot.too-large", `Turn snapshot is ${bytes} bytes; the limit is ${SNAPSHOT_LIMIT}.`),
      };
    return { ok: true, snapshot: built.snapshot, state: source.value.state };
  }

  private scopeStub(row: ThreadRow) {
    return remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(row.scope_id));
  }

  /** The Memory of this Thread's User as the `remember` and `recall` built-ins reach it. */
  private memoryHost(row: ThreadRow, config: MemoryConfig): MemoryHost {
    const user = row.user_id ?? undefined;
    const stub = user === undefined ? undefined : this.memoryStub(row, user);
    return {
      config,
      agent: row.agent_id,
      user,
      remember: async (write) => {
        if (!stub || user === undefined) return;
        // The index is written first, so stored Memory is always findable for deletion.
        await unwrap(this.scopeStub(row).memoryUsersAdd(row.scope_id, user));
        await unwrap(stub.remember(row.scope_id, user, write));
      },
      recall: async (query) => (stub && user !== undefined ? unwrap(stub.recall(row.scope_id, user, query)) : []),
    };
  }

  private memoryStub(row: ThreadRow, user: string) {
    return remote<MemoryDurableObject>(this.env.KARMI_MEMORY, keys.memory(row.scope_id, user));
  }

  /** The Memory Fragment of this Turn, or undefined on a user-less Thread or without a `memory` block. */
  private async memoryFragment(row: ThreadRow, spec: AgentSpec): Promise<string | undefined> {
    if (this.memory?.turn !== row.turn)
      this.memory = { turn: row.turn, text: await this.loadMemoryFragment(row, spec) };
    return this.memory.text;
  }

  private async loadMemoryFragment(row: ThreadRow, spec: AgentSpec): Promise<string | undefined> {
    if (!spec.memory || row.user_id === null) return undefined;
    const notes = notesEnabled(spec.memory);
    const view = await unwrap(
      this.memoryStub(row, row.user_id).get(row.scope_id, row.user_id, notes ? MEMORY_FRAGMENT_NOTES : 0),
    );
    return renderMemory(view, notes);
  }

  private logger(row: ThreadRow): Logger {
    return bindLogger(this.deployment.logger, {
      scope: row.scope_id,
      agent: row.agent_id,
      ...(row.user_id !== null && { user: row.user_id }),
      thread: row.thread_id,
      turn: row.turn,
    });
  }

  /** The attribution every Usage record of this Thread carries. */
  private usageAttribution(row: ThreadRow): UsageAttribution {
    const origin = this.delegations.origin();
    return {
      scope: row.scope_id,
      agent: row.agent_id,
      ...(row.user_id !== null && { user: row.user_id }),
      threadId: row.thread_id,
      ...(origin && { parent: origin.parent }),
    };
  }

  /** The Usage record of one model or compaction call, built from the Step's credentials and the call's usage. */
  private modelUsage(
    row: ThreadRow,
    kind: "model" | "compaction",
    model: string,
    { profile, started }: StepCall,
    usage: Usage,
  ): UsageRecordData {
    return {
      type: "usage.recorded",
      kind,
      ...this.usageAttribution(row),
      ...usage,
      model,
      provider: profile.adapter,
      profile: started.profile,
      ...(started.credential && {
        credentialSource: started.credential.source,
        credentialVersion: started.credential.version,
      }),
      ...(started.fallback && { fallback: started.fallback }),
    };
  }

  /**
   * Sends the Usage records waiting in the outbox to the Queue, at most `USAGE_BATCH` per message, and
   * re-arms itself while more wait. A failed send leaves the outbox as it was for the retry.
   */
  private async flushUsage(): Promise<void> {
    if (!this.env.KARMI_QUEUE) throw new KarmiError("bindings.missing", "Usage delivery requires KARMI_QUEUE.");
    const rows = this.sql
      .exec<EventRow>(
        "SELECT * FROM events WHERE seq IN (SELECT seq FROM usage_outbox) ORDER BY seq LIMIT ?",
        USAGE_BATCH + 1,
      )
      .toArray();
    const batch = rows.slice(0, USAGE_BATCH);
    const records: UsageRecord[] = [];
    for (const row of batch) {
      const event: ThreadEvent = { seq: row.seq, turn: row.turn, at: row.at, ...decodeEvent(row.json) };
      if (event.type === "usage.recorded") records.push(event);
    }
    if (records.length > 0) await this.env.KARMI_QUEUE.send({ kind: "usage", records } satisfies QueueMessage);
    this.sql.exec(`DELETE FROM usage_outbox WHERE seq <= ?`, batch.at(-1)?.seq ?? 0);
    if (rows.length > USAGE_BATCH) this.scheduleUsageFlush(this.deployment.clock.now());
  }

  private scheduleUsageFlush(dueAt: number): void {
    this.scheduler.set({ id: "usage", kind: "usage", dueAt, payload: null });
  }

  // Turn-level Hooks are dispatched by name with the Turn's context. `before-turn` and `before-compact`
  // may refuse by throwing, and the first `before-compact` decision wins. The observing points only log
  // a failure.
  private async turnHooks<
    P extends "before-turn" | "after-turn" | "on-error" | "before-compact" | "after-compact" | "after-tool",
  >(
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

  // Compaction is a Step of its own. It runs before a fresh model Step when the context is over its
  // limit, after a `context_window_exceeded` stop, or on `thread.compact()`. Its only lasting trace is
  // `thread.compacted`. The log before the cut is never touched.
  /** Reads the events the next model call is built from, starting at the last Compaction's `firstKeptSeq`. */
  private contextLog(): ContextLog {
    const { seq, firstKeptSeq } = this.lastCompaction();
    return { events: this.read(firstKeptSeq - 1, "part", Number.MAX_SAFE_INTEGER), floor: seq };
  }

  /** Returns the last Compaction's `seq`, 0 without one, and the first `seq` still in the model's context. */
  private lastCompaction(): { seq: number; firstKeptSeq: number } {
    const last = this.sql
      .exec<{ seq: number; json: string }>(
        "SELECT seq, json FROM events WHERE type = 'thread.compacted' ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    const compacted = last && decodeEvent(last.json);
    return { seq: last?.seq ?? 0, firstKeptSeq: compacted?.type === "thread.compacted" ? compacted.firstKeptSeq : 1 };
  }

  /** Folds every Load point since the last Compaction's `firstKeptSeq` into what the model's context has loaded. */
  private loaded(): Loaded {
    const rows = this.sql
      .exec<{ json: string }>(
        "SELECT json FROM events WHERE type = 'tools.loaded' AND seq >= ? ORDER BY seq",
        this.lastCompaction().firstKeptSeq,
      )
      .toArray();
    return foldLoaded(rows.map(({ json }) => decodeEvent(json)));
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

  /**
   * Runs a compact Step inside a Turn. A failure ends the Turn. An interrupted one re-runs whole, as only its
   * start was logged.
   */
  private async runCompactStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    context: ContextLog,
    channelRef: unknown,
  ): Promise<Next> {
    const result = await this.compactStep(row, snapshot, n, trigger, undefined, context, channelRef);
    return result.ok ? "continue" : stop(this.finish(this.row(), failure("compaction", result.message)));
  }

  private async compactStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    instructions: string | undefined,
    { events, floor }: ContextLog,
    channelRef: unknown,
  ): Promise<Outcome<CompactResult>> {
    const { spec, profile } = snapshot;
    const call = await this.startCompact(row, snapshot, n, trigger, channelRef);
    if (!call.ok) return compactionFailed(turnEndMessage(call.failure));
    const completed = () => this.append(row.turn, { type: "step.completed", kind: "compact", n }, channelRef);
    const tokensBefore = contextTokens(events);
    const cut = chooseCut(events, this.limits(snapshot), floor);
    if (!cut) return skipped(completed);
    const before = await this.turnHooks(row, snapshot, "before-compact", {
      trigger,
      ...(instructions !== undefined && { instructions }),
      tokensBefore,
    });
    if (!before.ok) return compactionFailed(turnEndMessage(before.failure));
    if (before.result && "skip" in before.result) return skipped(completed);
    const dropped = events.filter((event) => event.seq < cut.firstKeptSeq);
    const [, native] = splitModelId(spec.model.id);
    // A Hook's summary stands in for the Harness's call. Under the provider strategy the provider writes
    // its own block, so a Hook's summary is ignored there.
    const hookSummary = before.result && profile.compaction !== "provider" ? before.result.summary : undefined;
    let summary: Summary;
    if (hookSummary !== undefined) summary = { strategy: "hook", summary: hookSummary, usage: ZERO_USAGE };
    else {
      const written = await this.untilCancelled(this.summarise(row, snapshot, dropped, native, instructions, call));
      if (written === CANCELLED) return compactionFailed("The Turn was cancelled.");
      if (!written.ok) return written;
      summary = written.value;
    }
    const compacted: Compacted = {
      type: "thread.compacted",
      trigger,
      ...summary,
      firstKeptSeq: cut.firstKeptSeq,
      tokensBefore,
      tokensAfter: estimateTokens(summary.summary) + cut.tokensKept,
      provider: providerReplayKey(profile.adapter, spec.model.id),
      model: native,
      attachments: attachmentsOf(dropped),
    };
    return this.recordCompaction(row, snapshot, compacted, call, completed, channelRef);
  }

  /** Opens a compact Step by resolving the credentials for the summarising call and logging its `step.started`. */
  private async startCompact(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    n: number,
    trigger: CompactionTrigger,
    channelRef: unknown,
  ): Promise<({ ok: true } & StepCall) | { ok: false; failure: TurnEnd }> {
    this.update({ step: n, attempt: 1 });
    const call = await this.stepCredentials(row, snapshot, decodeFallback(row.fallback_json));
    if (!call.ok) return call;
    this.append(
      row.turn,
      {
        type: "step.started",
        kind: "compact",
        n,
        attempt: row.recoveries + 1,
        model: snapshot.spec.model.id,
        provider: call.profile.adapter,
        agentVersion: snapshot.agentVersion,
        trigger,
        ...call.started,
      },
      channelRef,
    );
    this.armWatchdog();
    return call;
  }

  /**
   * Records a finished Compaction. Its usage, the `thread.compacted` event and the Step's end are written
   * together, then the `after-compact` Hooks run.
   */
  private async recordCompaction(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    compacted: Compacted,
    call: StepCall,
    completed: () => unknown,
    channelRef: unknown,
  ): Promise<Outcome<CompactResult>> {
    this.update({ usage_json: JSON.stringify(addUsage(decodeUsage(this.row().usage_json), compacted.usage)) });
    this.append(row.turn, compacted, channelRef);
    // A Hook's summary made no model call, so there is nothing to bill.
    if (compacted.strategy !== "hook")
      this.append(row.turn, this.modelUsage(row, "compaction", compacted.model, call, compacted.usage), channelRef);
    completed();
    await this.turnHooks(row, snapshot, "after-compact", { compacted });
    return ok("compacted");
  }

  /**
   * Makes one summarising model call and returns the summary. Under the `harness` strategy it asks for
   * prose. Under the `provider` strategy it asks for the provider's own block and takes a prose reply
   * instead when the provider sends none, which happens for a context under the provider's compaction
   * minimum, so a small window never fails a Turn.
   */
  private async summarise(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    dropped: ThreadEvent[],
    native: string,
    instructions: string | undefined,
    { profile, credentials }: StepCall,
  ): Promise<Outcome<Summary>> {
    const { spec } = snapshot;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return compactionFailed(`Provider adapter "${profile.adapter}" is not registered.`);
    const messages = await this.replayMessages(row, dropped, profile, spec.model.id);
    const request: ProviderRequest = {
      model: native,
      config: profile,
      system: SUMMARY_SYSTEM,
      messages: [...messages, { role: "user", content: [{ type: "text", text: summaryInstruction(instructions) }] }],
      ...(profile.compaction === "provider" && { compact: { ...(instructions !== undefined && { instructions }) } }),
      ...(spec.model.params?.maxOutputTokens && { params: { maxOutputTokens: spec.model.params.maxOutputTokens } }),
      ...((profile.providerOptions || spec.model.providerOptions) && {
        providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions },
      }),
    };
    const logger = this.logger(row);
    const hosts = providerHosts(profile);
    const egress = scopedFetch({ ...(hosts && { hosts }), logger, fetch: this.deployment.fetch });
    const attribution = { scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn };
    const parts: ContentBlock[] = [];
    let usage = ZERO_USAGE;
    try {
      const stream = provider.stream(request, {
        fetch: egress,
        signal: this.turnAbort.signal,
        attribution,
        logger,
        media: this.media(row, snapshot.media),
        credentials,
      });
      for await (const event of stream) {
        if (event.type === "part") parts.push(event.block);
        else if (event.type === "error") return compactionFailed(event.error.message);
        else if (event.type === "message.end") usage = event.usage;
      }
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      return compactionFailed(errorMessage(error));
    }
    const block = parts.find((part) => part.type === "compaction");
    if (block)
      return ok({
        strategy: "provider",
        summary: block.summary,
        ...(block.raw !== undefined && { raw: block.raw }),
        usage,
      });
    const summary = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (!summary.trim()) return compactionFailed("The summarising call returned no text.");
    return ok({ strategy: "harness", summary, usage });
  }

  private async modelStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ToolSet,
    model: string,
    events: ThreadEvent[],
    channelRef: unknown,
    call: StepCall,
  ): Promise<StepResult> {
    const { profile, credentials } = call;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return stepError(`Provider adapter "${profile.adapter}" is not registered.`);
    const signal = this.turnAbort.signal;
    const logger = this.logger(row);
    try {
      const request = await this.modelRequest(row, snapshot, available, model, events, profile);
      const hosts = providerHosts(profile);
      const egress = scopedFetch({ ...(hosts && { hosts }), logger, fetch: this.deployment.fetch });
      const attribution = { scope: row.scope_id, agent: row.agent_id, thread: row.thread_id, turn: row.turn };
      const stream = provider.stream(request, {
        fetch: egress,
        signal,
        attribution,
        logger,
        media: this.media(row, snapshot.media),
        credentials,
      });
      return await this.recordStream(row, stream, signal, channelRef, splitModelId(model)[1], call, snapshot);
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      return stepError(errorMessage(error));
    }
  }

  private providerToolCounts(turn: number, limits: NonNullable<Capabilities["providerTools"]>["limits"]) {
    const count = (max: number | undefined, currentTurn: boolean): number => {
      if (max === undefined) return 0;
      return this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM
          (SELECT 1 FROM events WHERE type = 'server_tool.called' ${currentTurn ? "AND turn = ?" : ""} LIMIT ?)`,
          ...(currentTurn ? [turn, max] : [max]),
        )
        .one().count;
    };
    return { turn: count(limits?.maxCallsPerTurn, true), thread: count(limits?.maxCallsPerThread, false) };
  }

  /** The Provider request for one model Step: the Prompt, the replayed transcript and the offered Tools. */
  private async modelRequest(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ToolSet,
    model: string,
    events: ThreadEvent[],
    profile: ProviderConfig,
  ): Promise<ProviderRequest> {
    const { spec } = snapshot;
    const [, native] = splitModelId(model);
    const tools = toolDefinitions(available);
    const calls = this.providerToolCounts(row.turn, snapshot.providerTools?.limits);
    const providerTools = offeredProviderTools(snapshot.providerTools, snapshot.policy, calls);
    const memory = await this.memoryFragment(row, spec);
    const system = await evaluatePrompt(
      spec,
      this.deployment.catalogue,
      this.fragmentContext(row, snapshot, available, model),
      {
        ...(providerTools && { providerTools: providerTools.tools }),
        tools: toolsInContext(available),
        deferred: unloadedDeferred(available),
        skills: available.skills.map(({ skill, invokableBy }) => ({
          name: skill.name,
          description: skill.description,
          invokableBy,
        })),
        ...(memory !== undefined && { memory }),
      },
    );
    const messages = await this.replayMessages(row, events, profile, model);
    const mcpServers = this.mcp?.turn === row.turn ? (this.mcp.source?.providerServers() ?? []) : [];
    return {
      model: native,
      config: profile,
      ...(providerTools && { providerTools }),
      ...(system !== undefined && { system }),
      messages,
      ...(tools.length > 0 && { tools }),
      ...(mcpServers.length > 0 && { mcpServers }),
      ...(spec.model.params && { params: spec.model.params }),
      ...((profile.providerOptions || spec.model.providerOptions) && {
        providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions },
      }),
    };
  }

  private async replayMessages(row: ThreadRow, events: ThreadEvent[], profile: ProviderConfig, model: string) {
    const { messages } = prepareMessages(transcriptFromEvents(events), {
      provider: providerReplayKey(profile.adapter, model),
      model: splitModelId(model)[1],
    });
    const media = this.media(row);
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const [index, block] of message.content.entries()) {
        if (block.type === "server_tool")
          message.content[index] = await restoreProviderTool(block, (ref) => media.get(ref));
      }
    }
    return messages;
  }

  private async recordProviderTool(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    block: ContentBlock,
    channelRef: unknown,
    calls: Map<string, Extract<ContentBlock, { type: "server_tool" }>>,
  ): Promise<ContentBlock> {
    if (block.type !== "server_tool") return block;
    const limits = { ...AGENT_SPEC_DEFAULTS.context.toolOutput, ...snapshot.spec.context?.toolOutput };
    let called = calls.get(block.id);
    if (!called) {
      const output = providerOutput(
        block.raw ?? { id: block.id, name: block.name, input: block.input },
        limits,
        row.scope_id,
        row.thread_id,
        this.head + 1,
      );
      const { result, ...call } = block;
      called = { ...call, raw: output.raw, input: output.bytes ? output.raw : block.input };
      this.append(
        row.turn,
        {
          type: "server_tool.called",
          id: block.id,
          name: block.name,
          input: called.input,
          raw: output.raw,
          summary: `Called ${block.name}.`,
        },
        channelRef,
      );
      calls.set(block.id, called);
      await this.storeProviderOutput(output);
    }
    const persisted = { ...block, raw: called.raw, input: called.input };
    if (!block.result) return persisted;
    const output = providerOutput(block.result.raw, limits, row.scope_id, row.thread_id, this.head + 1);
    const raw = output.raw;
    const summaryCut = truncateOutput(block.result.summary, limits);
    const summary = summaryCut.truncated
      ? renderTruncated(summaryCut, isMediaRef(raw) ? raw : undefined)
      : block.result.summary;
    this.append(row.turn, { type: "server_tool.result", id: block.id, name: block.name, raw, summary }, channelRef);
    await this.storeProviderOutput(output);
    await this.turnHooks(row, snapshot, "after-tool", {
      call: structuredClone({ id: block.id, name: block.name, input: block.input, annotations: DEFAULT_ANNOTATIONS }),
      result: { content: [{ type: "text", text: summary }] },
    });
    return { ...persisted, result: { raw, summary } };
  }

  private async storeProviderOutput(output: ReturnType<typeof providerOutput>): Promise<void> {
    if (!output.bytes || !isMediaRef(output.raw)) return;
    if (!this.env.KARMI_MEDIA) throw new Error("Provider Tool output requires media storage.");
    await this.env.KARMI_MEDIA.put(output.raw.key, output.bytes, { httpMetadata: { contentType: "application/json" } });
    if (this.turnAbort.signal.aborted) {
      await this.env.KARMI_MEDIA.delete(output.raw.key);
      this.turnAbort.signal.throwIfAborted();
    }
  }

  /** Logs a Provider stream as it arrives and ends the model Step on the stream's terminal event. */
  private async recordStream(
    row: ThreadRow,
    stream: AsyncIterable<ProviderEvent>,
    signal: AbortSignal,
    channelRef: unknown,
    model: string,
    call: StepCall,
    snapshot: TurnSnapshot,
  ): Promise<StepResult> {
    const parts: ContentBlock[] = [];
    const calls = new Map<string, Extract<ContentBlock, { type: "server_tool" }>>();
    for await (const event of stream) {
      // A cancelled Turn has ended, so nothing of this stream belongs in the log any more.
      if (signal.aborted) return stepError("The Turn was cancelled.");
      switch (event.type) {
        case "server_tool.called":
          await this.recordProviderTool(row, snapshot, event.block, channelRef, calls);
          break;
        case "delta":
          this.append(
            row.turn,
            { type: "message.delta", index: event.index, kind: event.kind, text: event.text },
            channelRef,
          );
          break;
        case "part": {
          const block = await this.recordProviderTool(row, snapshot, event.block, channelRef, calls);
          if (signal.aborted) return stepError("The Turn was cancelled.");
          parts[event.index] = block;
          this.append(row.turn, { type: "message.part", index: event.index, block }, channelRef);
          break;
        }
        case "message.end": {
          const count = calls.size;
          const measured = {
            ...event.usage,
            ...(count > 0 && { serverToolCalls: Math.max(count, event.usage.serverToolCalls ?? 0) }),
          };
          const usage = addUsage(decodeUsage(this.row().usage_json), measured);
          this.update({ usage_json: JSON.stringify(usage) });
          this.append(row.turn, this.modelUsage(row, "model", model, call, measured), channelRef);
          this.append(
            row.turn,
            { type: "step.completed", kind: "model", n: row.step, stopReason: event.stopReason, usage: measured },
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

  /**
   * Handles a Tool call that needs a user-level Connection. ScopeConfig starts the OAuth flow, then a `connect`
   * request parks the Step on its URL.
   */
  private async requestConnection(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    channelRef: unknown,
    call: ToolCall,
    request: ConnectRequest,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const signal = this.turnAbort.signal;
    signal.throwIfAborted();
    const started = await this.scopeStub(row).mcpAuthorize(row.scope_id, {
      serverId: request.serverId,
      ...(request.level === "agent" ? { agent: row.agent_id } : { user: request.holder.slice("user:".length) }),
      ...(request.scope !== undefined && { scope: request.scope }),
      thread: { agent: row.agent_id, threadId: row.thread_id, ...(row.user_id !== null && { user: row.user_id }) },
    });
    if (!started.ok) return { ok: false, message: started.message };
    signal.throwIfAborted();
    this.request(
      row,
      snapshot,
      {
        type: "approval.requested",
        kind: "connect",
        id: call.id,
        tool: call.name,
        serverId: request.serverId,
        level: request.level,
        authUrl: started.value.authUrl,
      },
      channelRef,
    );
    return { ok: true };
  }

  private address(row: ThreadRow): ThreadAddress {
    return {
      scope: row.scope_id,
      agent: row.agent_id,
      threadId: row.thread_id,
      create: false,
      ...(row.user_id !== null && { user: row.user_id }),
    };
  }

  private threadStub(address: ThreadAddress) {
    return remote<ThreadDurableObject>(this.env.KARMI_THREADS, keys.thread(address.scope, address.threadId));
  }

  // Schedules are rows in this Durable Object with one alarm job each. A firing is a plain `send`, so it
  // coalesces like any other input. The scheduling built-ins address this Thread and nothing else.
  schedule(address: ThreadAddress, request: unknown): Outcome<{ scheduleId: string; nextAt: number }> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    const created = this.createSchedule(entered.value, request, crypto.randomUUID(), API_LIMITS, undefined);
    if (!created.ok) return fail(new KarmiError(created.code, created.message));
    return ok({ scheduleId: created.record.id, nextAt: created.record.nextAt });
  }

  cancelSchedule(address: ThreadAddress, scheduleId: string): Outcome<void> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    if (!this.removeSchedule(entered.value, scheduleId, undefined))
      return fail(new KarmiError("schedule.notFound", `No Schedule "${scheduleId}" on this Thread.`));
    return ok(undefined);
  }

  schedules(address: ThreadAddress): Outcome<ScheduleSummary[]> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    return ok(this.scheduleStore.list().map(summarise));
  }

  private schedulingHost(row: ThreadRow, limits: SchedulingLimits, channelRef: unknown) {
    return {
      create: (request: ScheduleRequest, id: string) => {
        const created = this.createSchedule(row, request, id, limits, channelRef);
        return created.ok ? { ok: true as const, summary: summarise(created.record) } : created;
      },
      cancel: (id: string) => this.removeSchedule(row, id, channelRef),
      list: () => this.scheduleStore.list().map(summarise),
    };
  }

  /**
   * Validates, caps, stores and arms one Schedule. An existing id is returned as is, so a re-run creates
   * nothing twice.
   */
  private createSchedule(
    row: ThreadRow,
    request: unknown,
    id: string,
    limits: SchedulingLimits,
    channelRef: unknown,
  ): { ok: true; record: ScheduleRecord } | ({ ok: false } & ScheduleFailure) {
    const existing = this.scheduleStore.get(id);
    if (existing) return { ok: true, record: existing };
    const now = this.deployment.clock.now();
    const resolved = resolveSchedule(request, now);
    if (!resolved.ok) return resolved;
    const limit = overScheduleLimit(limits, resolved.timing, this.scheduleStore.count(), resolved.nextAt, now);
    if (limit) return { ok: false, code: "schedule.limit", message: `limit_exceeded: ${limit}` };
    const { input, delay } = resolved.request;
    const record: ScheduleRecord = { id, timing: resolved.timing, input, createdAt: now, nextAt: resolved.nextAt };
    this.scheduleStore.save(record);
    this.scheduler.set({ id: scheduleJobId(id), kind: "schedule", dueAt: record.nextAt, payload: { scheduleId: id } });
    this.append(
      row.turn,
      {
        type: "schedule.created",
        scheduleId: id,
        ...(resolved.timing.kind === "once" && delay === undefined && { at: resolved.timing.at }),
        ...(delay !== undefined && { delay: resolved.nextAt - now }),
        ...(resolved.timing.kind === "cron" && { cron: resolved.timing.cron, tz: resolved.timing.tz }),
        nextAt: record.nextAt,
        input,
      },
      channelRef ?? input.channelRef,
    );
    return { ok: true, record };
  }

  private removeSchedule(row: ThreadRow, id: string, channelRef: unknown): boolean {
    if (!this.scheduleStore.get(id)) return false;
    this.scheduleStore.delete(id);
    this.scheduler.cancel(scheduleJobId(id));
    this.append(row.turn, { type: "schedule.cancelled", scheduleId: id }, channelRef);
    return true;
  }

  /**
   * The alarm for one Schedule. The firing is queued as an input and coalesces if a Turn is running or
   * parked. A cron whose last firing is still queued drops this tick instead of stacking a second one.
   */
  private fireSchedule(scheduleId: string): void {
    const record = this.scheduleStore.get(scheduleId);
    if (!record) return;
    const row = this.row();
    const undelivered =
      record.pendingInput !== undefined &&
      this.sql.exec("SELECT id FROM inputs WHERE id = ?", record.pendingInput).toArray().length > 0;
    const now = this.deployment.clock.now();
    const nextAt = record.timing.kind === "cron" ? nextCronTime(record.timing.cron, now, record.timing.tz) : undefined;
    if (undelivered && nextAt !== undefined) {
      this.append(row.turn, { type: "schedule.skipped", scheduleId, nextAt }, record.input.channelRef);
    } else {
      const entered = this.enter(this.address(row));
      if (!entered.ok) this.logger(row).warn("Schedule firing refused", { scheduleId, code: entered.code });
      else {
        record.pendingInput = this.enqueue(entered.value, record.input, false).id;
        this.append(
          row.turn,
          { type: "schedule.fired", scheduleId, ...(nextAt !== undefined && { nextAt }) },
          record.input.channelRef,
        );
      }
    }
    if (nextAt === undefined) return this.scheduleStore.delete(scheduleId);
    record.nextAt = nextAt;
    this.scheduleStore.save(record);
    this.scheduler.set({ id: scheduleJobId(scheduleId), kind: "schedule", dueAt: nextAt, payload: { scheduleId } });
  }

  delegationReserve(ancestor: Ancestor, id: string): string | undefined {
    const entered = this.enter(ancestor.address);
    if (
      !entered.ok ||
      entered.value.turn !== ancestor.turn ||
      entered.value.state === "idle" ||
      entered.value.cancelled
    )
      return "parent_cancelled";
    if (this.deployment.clock.now() >= ancestor.deadline) return "maxWallMs";
    return this.delegations.reserve(id, ancestor);
  }

  delegationRelease(address: ThreadAddress, id: string, rollback: boolean): void {
    const entered = this.enter(address);
    if (entered.ok) this.delegations.release(id, rollback);
  }

  delegationStart(address: ThreadAddress, origin: ChildOrigin, input: TurnInput): Outcome<void> {
    const entered = this.enter(address);
    if (!entered.ok) return entered;
    if (this.delegations.origin()) return ok(undefined);
    if (entered.value.turn > 0 || this.hasInputs())
      return fail(new KarmiError("thread.busy", "Child Thread already exists."));
    this.delegations.attach(origin);
    const deadline = Math.min(...origin.chain.map((a) => a.deadline));
    this.scheduler.set({ id: "delegation-deadline", kind: "delegation-deadline", dueAt: deadline, payload: null });
    const sent = this.send(address, input);
    return sent.ok ? ok(undefined) : sent;
  }

  private async delegate(row: ThreadRow, snapshot: TurnSnapshot, input: DelegateInput, stableId: string) {
    const prior = this.delegations.child(stableId);
    if (prior?.reserved) return { pending: stableId };
    if (!snapshot.spec.delegates?.includes(input.agent))
      return delegationError(`Agent "${input.agent}" is not an allowed delegate.`);
    const inherited = this.delegations.origin()?.chain ?? [];
    const address = this.address(row);
    const previousDeadline =
      this.delegations.children(row.turn)[0]?.origin.chain.at(-1)?.deadline ?? Number.MAX_SAFE_INTEGER;
    const deadline = Math.min(
      previousDeadline,
      delegationDeadline(this.deployment.clock.now(), snapshot.budget, this.readTurn(row).budget, inherited),
    );
    const chain = [
      ...inherited,
      {
        address,
        turn: row.turn,
        limits: snapshot.delegation ?? snapshot.spec.capabilities?.delegation ?? {},
        deadline,
      },
    ];
    if (depthLimit(chain, input.agent)) return delegationError("limit_exceeded: maxDepth");
    const childAddress = {
      ...address,
      create: true,
      agent: input.agent,
      threadId: keys.childThread(row.thread_id, stableId),
    };
    const origin = { parent: { threadKey: encodeKey(address), callId: stableId }, chain };
    const child: DelegationRecord = {
      id: stableId,
      turn: row.turn,
      address: childAddress,
      origin,
      input: {
        kind: "message",
        parts: [
          { type: "text", text: input.task },
          ...(input.attachments ?? []).map((media) => ({ type: "file" as const, media })),
        ],
      },
      after: 0,
      reserved: false,
      started: false,
      done: false,
      released: false,
    };
    const limit = await this.admitDelegation(row, child);
    if (limit) return delegationError(`limit_exceeded: ${limit}`);
    this.scheduler.set({ id: "delegation-deadline", kind: "delegation-deadline", dueAt: deadline, payload: null });
    this.append(
      row.turn,
      { type: "delegation.started", id: stableId, childKey: encodeKey(childAddress) },
      this.turnInput(row.turn)?.channelRef,
    );
    this.scheduler.set({ id: "delegation", kind: "delegation", dueAt: this.deployment.clock.now(), payload: null });
    return { pending: stableId };
  }

  private async admitDelegation(row: ThreadRow, child: DelegationRecord): Promise<string | undefined> {
    // The record is saved before any remote reservation so a cancel can find and release a partly reserved
    // child.
    this.delegations.save(child);
    try {
      const limit = await this.reserveDelegation(row, child.origin.chain, child.id);
      if (!limit) {
        child.reserved = true;
        this.delegations.save(child);
        return;
      }
      child.done = true;
      this.delegations.save(child);
      await this.releaseChild(child);
      return limit;
    } catch (error) {
      child.done = true;
      this.delegations.save(child);
      await this.releaseChild(child);
      return errorMessage(error);
    }
  }

  private async reserveDelegation(row: ThreadRow, chain: Ancestor[], id: string): Promise<string | undefined> {
    for (const ancestor of chain) {
      const limit =
        ancestor.address.threadId === row.thread_id
          ? this.delegationReserve(ancestor, id)
          : await this.threadStub(ancestor.address).delegationReserve(ancestor, id);
      if (limit) {
        return limit;
      }
    }
    const current = this.row();
    if (current.cancelled || current.turn !== row.turn || current.state === "idle") {
      return "parent_cancelled";
    }
  }

  private async releaseDelegation(chain: Ancestor[], id: string, rollback: boolean): Promise<void> {
    const own = this.row().thread_id;
    await Promise.all(
      chain.map((ancestor) =>
        ancestor.address.threadId === own
          ? this.delegations.release(id, rollback)
          : this.threadStub(ancestor.address).delegationRelease(ancestor.address, id, rollback),
      ),
    );
  }

  async delegationChanged(address: ThreadAddress): Promise<void> {
    const entered = this.enter(address);
    if (!entered.ok) return;
    this.scheduler.set({ id: "delegation", kind: "delegation", dueAt: this.deployment.clock.now(), payload: null });
    await this.syncDelegations();
  }

  private syncDelegations(): Promise<void> {
    if (this.syncWork) {
      this.syncAgain = true;
      return this.syncWork;
    }
    const work = this.syncDelegationLoop().finally(() => {
      this.syncWork = undefined;
    });
    this.syncWork = work;
    return work;
  }

  private async syncDelegationLoop(): Promise<void> {
    do {
      this.syncAgain = false;
      const children = this.delegations.outstanding();
      await Promise.all(children.map((child) => this.syncChild(child)));
    } while (this.syncAgain);
  }

  private async syncChild(child: DelegationRecord): Promise<void> {
    if (child.done) {
      await this.releaseChild(child);
      await this.settle(this.row());
      return;
    }
    const row = this.row();
    if (row.turn !== child.turn || row.state === "idle" || row.cancelled) {
      await this.stopChild(child);
      return;
    }
    // A start waits until the Tool has persisted its pending result.
    if (![...this.readTurn(row).jobs.values()].some((job) => job.jobId === child.id)) return;
    const stub = this.threadStub(child.address);
    if (!child.started) {
      const started = await stub.delegationStart(child.address, child.origin, child.input);
      if (!started.ok) {
        await this.completeChild(child, delegationError(`${started.code}: ${started.message}`));
        return;
      }
      if (this.delegations.child(child.id)?.done) {
        await stub.cancel(child.address);
        return;
      }
      child.started = true;
      this.delegations.save(child);
    }
    const events = await stub.events(child.address, child.after);
    if (!events.ok) {
      await this.completeChild(child, delegationError(events.message));
      return;
    }
    for (const event of events.value) {
      if (this.row().turn !== child.turn || this.row().state === "idle" || this.row().cancelled) return;
      if (event.type === "approval.requested") this.bubbleApproval(child, event);
      if (event.type === "approval.resolved") this.bubbleResolution(child, event);
      child.after = event.seq;
      this.delegations.save(child);
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        await this.completeChild(child, delegationResult(event));
        return;
      }
    }
  }

  private bubbleApproval(child: DelegationRecord, event: Extract<ThreadEvent, { type: "approval.requested" }>): void {
    const row = this.row();
    const { seq: _seq, at: _at, turn: _turn, channelRef: _channel, ...data } = event;
    this.append(
      row.turn,
      { ...data, child: { threadId: child.address.threadId, seq: event.seq } },
      this.turnInput(row.turn)?.channelRef,
    );
  }

  private bubbleResolution(child: DelegationRecord, event: Extract<ThreadEvent, { type: "approval.resolved" }>): void {
    const row = this.row();
    for (const [seq, request] of this.readTurn(row).requests) {
      if (request.child?.threadId !== child.address.threadId || request.child.seq !== event.request || request.answered)
        continue;
      this.resolve(
        row,
        seq,
        request,
        {
          decision: event.decision,
          ...(event.by && { by: event.by }),
          ...(event.reason !== undefined && { reason: event.reason }),
        },
        event.source,
      );
    }
  }

  private async completeChild(child: DelegationRecord, result: ToolResult): Promise<void> {
    const row = this.row();
    if (row.turn !== child.turn || row.state === "idle" || row.cancelled) return this.stopChild(child);
    this.append(
      row.turn,
      { type: "delegation.completed", id: child.origin.parent.callId, childKey: encodeKey(child.address), result },
      this.turnInput(row.turn)?.channelRef,
    );
    this.append(row.turn, { type: "job.completed", jobId: child.id, result }, this.turnInput(row.turn)?.channelRef);
    child.done = true;
    this.delegations.save(child);
    await this.releaseChild(child);
    await this.settle(this.row());
  }

  private async stopChild(child: DelegationRecord): Promise<void> {
    const cancelled = await this.threadStub(child.address).cancel({ ...child.address, create: false });
    if (!cancelled.ok && cancelled.code !== "thread.notFound") throw new KarmiError(cancelled.code, cancelled.message);
    child.done = true;
    this.delegations.save(child);
    await this.releaseChild(child);
  }

  private async releaseChild(child: DelegationRecord): Promise<void> {
    // The delegation job is armed first so the release is retried when a remote ancestor is unavailable.
    this.scheduler.set({ id: "delegation", kind: "delegation", dueAt: this.deployment.clock.now(), payload: null });
    await this.releaseDelegation(child.origin.chain, child.id, !child.reserved);
    child.released = true;
    this.delegations.save(child);
  }

  private async notifyParent(): Promise<void> {
    const origin = this.delegations.origin();
    const parent = origin?.chain.at(-1);
    if (!parent) return;
    await this.threadStub(parent.address).delegationChanged(parent.address);
  }

  private scheduleParentNotification(): void {
    if (!this.delegations.origin()) return;
    this.scheduler.set({
      id: "delegation-notify",
      kind: "delegation-notify",
      dueAt: this.deployment.clock.now(),
      payload: null,
    });
    void this.notifyParent().catch((error) =>
      this.deployment.logger.warn("Delegation notification deferred", { error: errorMessage(error) }),
    );
  }

  private scriptExecution(row: ThreadRow, snapshot: TurnSnapshot) {
    if (!snapshot.scripts || !this.env.KARMI_LOADER) return {};
    return {
      scripts: {
        sandbox: new CloudflareIsolateSandbox(this.env.KARMI_LOADER),
        limits: snapshot.scripts,
        result: async (callId: string) => {
          const seq = keys.toolCallSeq(row.thread_id, callId);
          if (seq === undefined) throw new Error("Unknown callId on this Thread.");
          const [call] = this.read(seq - 1, "part", 1, seq);
          if (!call || call.type !== "tool.call") throw new Error("Unknown callId on this Thread.");
          const result = this.sql
            .exec<EventRow>(
              `SELECT * FROM events
               WHERE seq > ? AND turn = ? AND type = 'tool.result' AND json_extract(json, '$.id') = ?
               ORDER BY seq LIMIT 1`,
              seq,
              call.turn,
              call.id,
            )
            .toArray()
            .map((row) => decodeEvent(row.json))[0];
          if (!result || result.type !== "tool.result") throw new Error("No result for this callId.");
          return readScriptResult(this.env.KARMI_MEDIA, result);
        },
      },
    };
  }

  private toolStep(
    row: ThreadRow,
    snapshot: TurnSnapshot,
    available: ToolSet,
    attempt: number,
    batch: ToolCall[],
    prior: PriorCalls,
    channelRef: unknown,
  ): ReturnType<typeof runToolStep> {
    const stub = this.scopeStub(row);
    const signal = this.turnAbort.signal;
    const origin = this.delegations.origin();
    return runToolStep(
      {
        scope: row.scope_id,
        ...(row.user_id !== null && { user: row.user_id }),
        threadId: row.thread_id,
        agent: row.agent_id,
        ...(origin && { parent: origin.parent }),
        turn: row.turn,
        attempt,
        spec: snapshot.spec,
        catalogue: this.deployment.catalogue,
        ...this.scriptExecution(row, snapshot),
        now: () => this.deployment.clock.now(),
        available: available.available,
        loaded: available.loaded,
        bucket: this.env.KARMI_MEDIA,
        mediaLimits: snapshot.media,
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
        connect: (call, request) => this.requestConnection(row, snapshot, channelRef, call, request),
        connection: async (level, name) => {
          const value =
            level === "user"
              ? row.user_id === null
                ? undefined
                : await stub.userConnectionGet(row.scope_id, row.user_id, name)
              : await stub.connectionGet(row.scope_id, row.agent_id, name);
          return value?.ok ? value.value : undefined;
        },
      },
      batch,
      prior,
    );
  }
}

export type { TurnEnd } from "./hook";

/** Whether `event` ends or parks a Turn. */
export function isTurnEnd(event: ThreadEventData): event is TurnEnd {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused";
}

const failure = (reason: string, message: string): TurnEnd => ({ type: "turn.failed", reason, message });
const stop = async (work: Promise<void>): Promise<"stop"> => {
  await work;
  return "stop";
};
/**
 * Ends a called-off compact Step as completed and returns `skipped`. The fold needs the Step's end so it does
 * not re-run it.
 */
const skipped = (completed: () => unknown): Outcome<CompactResult> => {
  completed();
  return ok("skipped");
};
const compactionFailed = (message: string) => fail(new KarmiError("compaction.failed", message));
/** Whether the plan re-runs a Step the log left unfinished rather than starting a new one. */
const isRerun = (plan: Plan): boolean => plan.kind === "compact" || (plan.kind !== "finish" && !plan.fresh);
const turnEndMessage = (end: TurnEnd): string =>
  end.type === "turn.failed" ? end.message : `The Turn ${end.type === "turn.paused" ? "was parked" : "ended"}.`;
const stepError = (message: string): StepResult => ({
  ok: false,
  error: { code: "unknown", message, retryable: false },
});

/**
 * Builds the secret-free snapshot of one Turn from what the Scope resolved. The fallback target is the
 * Deployment's profile of that name, never a Scope profile.
 */
function buildSnapshot(
  source: TurnSnapshotSource,
  deploymentProfiles: Record<string, ProviderConfig>,
  agentId: string,
): { ok: true; snapshot: TurnSnapshot } | { ok: false; failure: TurnEnd } {
  const { version } = source.agent;
  const spec = source.agent.spec as AgentSpec;
  const chosen = chooseProfile(spec.model.providerProfile, source.config.providers ?? {});
  if (!chosen)
    return {
      ok: false,
      failure: failure("provider.profile.unknown", `Agent "${agentId}" names no configured Provider profile.`),
    };
  const { profile } = chosen;
  const target = profile.fallback && deploymentProfiles[profile.fallback.profile];
  const ceilings = source.config.ceilings ?? {};
  return {
    ok: true,
    snapshot: {
      media: source.config.media,
      agentVersion: version,
      spec,
      profile,
      profileName: chosen.name,
      ...(profile.fallback &&
        target && {
          fallback: { name: profile.fallback.profile, profile: target, on: profile.fallback.on ?? ["missing"] },
        }),
      policy: [...(source.config.policy ?? []), ...(spec.policy ?? [])],
      approvalTimeout: Math.min(
        spec.approvals?.timeout ?? AGENT_SPEC_DEFAULTS.approvals.timeout,
        ceilings.approvals?.timeout ?? UNBOUNDED,
      ),
      ...(spec.capabilities?.delegation && {
        delegation: resolveDelegationLimits(spec.capabilities.delegation, ceilings.delegation),
      }),
      ...(spec.capabilities?.scripts?.tier === "isolate" && {
        scripts: resolveScriptLimits(spec.capabilities.scripts, ceilings.scripts),
      }),
      ...(spec.capabilities?.scheduling && {
        scheduling: resolveSchedulingLimits(spec.capabilities.scheduling, ceilings.scheduling),
      }),
      ...(spec.capabilities?.providerTools && {
        providerTools: resolveProviderTools(spec.capabilities.providerTools, ceilings.providerTools),
      }),
      budget: resolveBudget(spec.capabilities?.longRunning, ceilings.longRunning),
      context: resolveContext(spec, ceilings),
      ...mcpSnapshot(spec, source.config),
    },
  };
}

/** The `mcp` part of a snapshot: only the servers the Spec references. Empty when the Spec names none. */
function mcpSnapshot(spec: AgentSpec, config: ScopeConfigDocument): Pick<TurnSnapshot, "mcp"> {
  const servers: Record<string, McpServerConfig> = {};
  for (const ref of spec.tools ?? []) {
    const mcp = parseMcpReference(typeof ref === "string" ? ref : ref.name);
    const server = mcp && config.mcp?.servers?.[mcp.server];
    if (mcp && server) servers[mcp.server] = server;
  }
  if (Object.keys(servers).length === 0) return {};
  const hosts = config.egress?.mcpHosts;
  return { mcp: { servers, ...(hosts && { hosts }) } };
}

/** Decodes `thread.fallback_json`. A row from before the column existed reads as no fallback engaged. */
function decodeFallback(json: string | null): FallbackEngaged | undefined {
  return json === null ? undefined : JSON.parse(json);
}

/**
 * The Turn budget of a `longRunning` grant: each bound it names, unbounded for the rest, capped by the Scope
 * ceiling. Without a grant it is `DEFAULT_BUDGET` under the same cap.
 */
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

/** The Spec's `context` settings with the defaults filled in. `window` stays absent so the model's own applies. */
function resolveContext(spec: Pick<AgentSpec, "context">, ceilings: Ceilings): TurnSnapshot["context"] {
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
  const optional = (key: "cacheWrite1h" | "reasoning" | "serverToolCalls") =>
    total[key] === undefined && usage[key] === undefined ? {} : { [key]: (total[key] ?? 0) + (usage[key] ?? 0) };
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    ...optional("cacheWrite1h"),
    ...optional("reasoning"),
    ...optional("serverToolCalls"),
  };
}

function decodeScheduleJob(value: unknown): string {
  if (!value || typeof value !== "object" || !("scheduleId" in value) || typeof value.scheduleId !== "string")
    throw new Error("Invalid Schedule job.");
  return value.scheduleId;
}

function decodeCleanup(value: unknown): ThreadAddress {
  if (
    !value ||
    typeof value !== "object" ||
    !("scope" in value) ||
    typeof value.scope !== "string" ||
    !("threadId" in value) ||
    typeof value.threadId !== "string" ||
    !("agent" in value) ||
    typeof value.agent !== "string"
  )
    throw new Error("Invalid Thread cleanup job.");
  return { scope: value.scope, threadId: value.threadId, agent: value.agent, create: false };
}
