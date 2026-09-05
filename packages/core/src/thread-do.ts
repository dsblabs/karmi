import { DurableObject } from "cloudflare:workers";
import type { AgentSpec } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import type { Deployment } from "./deployment.js";
import { KarmiError } from "./errors.js";
import { keys } from "./keys.js";
import { fail, ok, remote, type Outcome } from "./outcome.js";
import { evaluatePrompt } from "./prompt.js";
import type { ContentBlock, ProviderError, StopReason, Usage } from "./provider.js";
import { prepareMessages } from "./replay.js";
import type { ProviderConfig } from "./scope-config.js";
import type { ScopeConfigDurableObject } from "./scope-config-do.js";
import { titleOf, type ThreadAddress, type ThreadStatus } from "./thread.js";
import type { Granularity, ThreadEvent, ThreadEventData, ThreadEventType, TurnInput } from "./thread-events.js";
import { splitModelId, transcriptFromEvents } from "./transcript.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread (scope_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, attempt INTEGER NOT NULL, recoveries INTEGER NOT NULL, agent_version INTEGER, snapshot_json TEXT, usage_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL, json TEXT NOT NULL);
`;

/** Eager snapshot ceiling; a larger one is a Spec problem, not something to page lazily. */
export const SNAPSHOT_LIMIT = 256 * 1024;
const MAX_RECOVERIES = 3;
const POLL_TIMEOUT_MS = 15_000;
const POLL_LIMIT = 256;
/** A Step past this without progress is presumed lost; the alarm re-enters the loop. */
const STEP_WATCHDOG_MS = 60_000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What a Turn runs under, persisted locally at its first Step so a Spec change lands on the next Turn. */
export interface TurnSnapshot {
  agentVersion: number;
  /** Stored normalized; a JSON round trip already dropped every explicit `undefined`. */
  spec: AgentSpec;
  /** The chosen Provider profile, secret-free. */
  profile: ProviderConfig;
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
  agent_version: number | null;
  snapshot_json: string | null;
  usage_json: string;
};

type EventRow = { seq: number; turn: number; at: number; type: ThreadEventType; json: string };

/** A model Step outcome: the Provider finished, or it failed and the next fallback should try. */
type StepResult = { ok: true; stopReason: StopReason; message: ContentBlock[] } | { ok: false; error: ProviderError };

export abstract class ThreadDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;

  private head = 0;
  private active = false;
  /** Subscribers parked on an empty poll; each append wakes them all. */
  private waiters: (() => void)[] = [];

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
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
      row = { scope_id: address.scope, agent_id: address.agent, user_id: address.user ?? null, thread_id: address.threadId, created_at: Date.now(), state: "idle", turn: 0, step: 0, attempt: 0, recoveries: 0, agent_version: null, snapshot_json: null, usage_json: JSON.stringify(ZERO_USAGE) };
      this.sql.exec("INSERT INTO thread (scope_id, agent_id, user_id, thread_id, created_at, state, turn, step, attempt, recoveries, agent_version, snapshot_json, usage_json) VALUES (?, ?, ?, ?, ?, 'idle', 0, 0, 0, 0, NULL, NULL, ?)", row.scope_id, row.agent_id, row.user_id, row.thread_id, row.created_at, row.usage_json);
    } else if (row.scope_id !== address.scope || row.thread_id !== address.threadId) {
      throw new Error(`Thread "${row.scope_id}/${row.thread_id}" was addressed as "${address.scope}/${address.threadId}".`);
    } else if (row.agent_id !== address.agent || row.user_id !== (address.user ?? null)) {
      return fail(new KarmiError("thread.mismatch", `Thread "${address.threadId}" belongs to Agent "${row.agent_id}"${row.user_id === null ? "" : ` and User "${row.user_id}"`}.`));
    }
    return ok(row);
  }

  send(address: ThreadAddress, input: TurnInput): Outcome<{ turn: number; seq: number }> {
    const row = this.enter(address);
    if (!row.ok) return row;
    // A running or parked Turn owns its number; queued inputs run one Turn each, in order, after it.
    const queued = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inputs").one().n;
    const turn = row.value.turn + 1 + queued;
    this.sql.exec("INSERT INTO inputs (turn, json) VALUES (?, ?)", turn, JSON.stringify(input));
    if (!this.active) this.ctx.waitUntil(this.run());
    return ok({ turn, seq: this.head });
  }

  events(address: ThreadAddress, after: number): Outcome<ThreadEvent[]> {
    const row = this.enter(address);
    if (!row.ok) return row;
    return ok(this.read(after, "delta", Number.MAX_SAFE_INTEGER));
  }

  status(address: ThreadAddress): Outcome<ThreadStatus> {
    const row = this.enter(address);
    if (!row.ok) return row;
    const { state, turn, step, agent_version, usage_json } = row.value;
    return ok({ state, ...(state !== "idle" && { turn, step }), ...(agent_version !== null && { agentVersion: agent_version }), usage: JSON.parse(usage_json) as Usage, seq: this.head });
  }

  /** Returns the next events after `after`, waiting for the first one when the log has nothing yet. */
  async poll(address: ThreadAddress, after: number, granularity: Granularity): Promise<Outcome<ThreadEvent[]>> {
    const row = this.enter(address);
    if (!row.ok) return row;
    if (after > this.head) return fail(new KarmiError("thread.seq.invalid", `The log ends at seq ${this.head}; cannot subscribe after ${after}.`));
    if (after === this.head) await this.nextAppend();
    return ok(this.read(after, granularity, POLL_LIMIT));
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
    const at = Date.now();
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

  // The watchdog: a Step still streaming is fine, so the alarm is pushed out; a Turn left `running` by an
  // eviction re-enters the loop, and one interrupted too often fails rather than looping forever.
  async alarm(): Promise<void> {
    if (this.active) return void this.ctx.storage.setAlarm(Date.now() + STEP_WATCHDOG_MS);
    const row = this.sql.exec<ThreadRow>("SELECT * FROM thread").toArray()[0];
    if (row?.state !== "running") return;
    const recoveries = row.recoveries + 1;
    this.update({ recoveries });
    if (recoveries > MAX_RECOVERIES) this.finish(row, failure("recovery", `Step ${row.step} of Turn ${row.turn} was interrupted ${recoveries} times.`));
    await this.run();
  }

  // The Turn loop: one instance at a time, driven by `send` and the watchdog alarm. It resumes whatever
  // the row says is in flight, then drains queued inputs one Turn each.
  private async run(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (;;) {
        let row = this.row();
        if (row.state === "parked") {
          if (!this.sql.exec<{ id: number }>("SELECT id FROM inputs LIMIT 1").toArray()[0]) return;
          this.append(row.turn, { type: "turn.resumed", reason: "input" }, this.turnInput(row.turn)?.channelRef);
          this.update({ state: "running" });
          row = this.row();
        } else if (row.state === "idle") {
          const next = this.sql.exec<{ id: number; json: string }>("SELECT id, json FROM inputs ORDER BY id LIMIT 1").toArray()[0];
          if (!next) return;
          // Nothing may yield between taking the input and logging it, or an eviction would lose it.
          const toolsVersion = await this.deployment.catalogue.fingerprint();
          const input = JSON.parse(next.json) as TurnInput;
          const turn = row.turn + 1;
          this.sql.exec("DELETE FROM inputs WHERE id = ?", next.id);
          this.update({ state: "running", turn, step: 0, attempt: 0, recoveries: 0, snapshot_json: null });
          this.append(turn, { type: "turn.started", input, toolsVersion }, input.channelRef);
          row = this.row();
        }
        await this.turn(row);
        // Parked again: the input stays queued for the next resume attempt rather than spinning here.
        if (this.row().state === "parked") return;
      }
    } finally {
      this.active = false;
    }
  }

  private turnInput(turn: number): TurnInput | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM events WHERE turn = ? AND type = 'turn.started' LIMIT 1", turn).toArray()[0];
    return row ? (JSON.parse(row.json) as { input: TurnInput }).input : undefined;
  }

  private finish(row: ThreadRow, data: TurnEnd): void {
    this.append(row.turn, data, this.turnInput(row.turn)?.channelRef);
    if (data.type === "turn.paused") this.update({ state: "parked" });
    else this.update({ state: "idle", step: 0, attempt: 0, recoveries: 0, snapshot_json: null });
    void this.ctx.storage.deleteAlarm();
  }

  // One Turn from wherever the row says it stands: no tools yet, so a single model Step. `attempt`
  // is the attempt to (re)run next, so an eviction re-runs the same model and only a Provider
  // failure rotates to the next fallback.
  private async turn(row: ThreadRow): Promise<void> {
    const channelRef = this.turnInput(row.turn)?.channelRef;
    const boundary = await this.snapshot(row);
    if (!boundary.ok) return this.finish(row, boundary.failure);
    const snapshot = boundary.snapshot;
    const step = Math.max(row.step, 1);
    const attempt = Math.max(row.attempt, 1);
    const models = [snapshot.spec.model.id, ...(snapshot.spec.model.fallbacks ?? [])];
    const model = models[attempt - 1];
    if (model === undefined) return this.finish(row, failure("provider", `Every model of Agent "${row.agent_id}" failed.`));
    this.update({ step, attempt });
    this.append(row.turn, { type: "step.started", kind: "model", n: step, attempt, model, provider: snapshot.profile.adapter, agentVersion: snapshot.agentVersion }, channelRef);
    void this.ctx.storage.setAlarm(Date.now() + STEP_WATCHDOG_MS);

    const result = await this.modelStep({ ...row, step }, snapshot, model, channelRef);
    if (result.ok) return this.finish(row, { type: "turn.completed", stopReason: result.stopReason, message: result.message });
    // The failed attempt stays in the log; the transcript ignores Steps that never completed.
    this.update({ attempt: attempt + 1 });
    return this.turn(this.row());
  }

  // The Step boundary: the first Step takes the Turn snapshot from the Scope and persists it; every
  // Step checks the Scope is still active.
  private async snapshot(row: ThreadRow): Promise<{ ok: true; snapshot: TurnSnapshot } | { ok: false; failure: TurnEnd }> {
    const stub = remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(row.scope_id));
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
      const source = await stub.turnSnapshot(row.scope_id, row.agent_id, { threadId: row.thread_id, ...(row.user_id !== null && { userId: row.user_id }), createdAt: row.created_at, activeAt: Date.now(), ...(title !== undefined && { title }) });
      if (!source.ok) return { ok: false, failure: failure(source.code, source.message) };
      const { version } = source.value.agent;
      const spec = source.value.agent.spec as AgentSpec;
      const profile = resolveProfile(spec, source.value.config.providers ?? {});
      if (!profile) return { ok: false, failure: failure("provider.profile.unknown", `Agent "${row.agent_id}" names no configured Provider profile.`) };
      snapshot = { agentVersion: version, spec, profile };
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

  private async modelStep(row: ThreadRow, snapshot: TurnSnapshot, model: string, channelRef: unknown): Promise<StepResult> {
    const { spec, profile } = snapshot;
    const provider = this.deployment.providers[profile.adapter];
    if (!provider) return stepError(`Provider adapter "${profile.adapter}" is not registered.`);
    const [, native] = splitModelId(model);
    const parts: ContentBlock[] = [];
    try {
      const system = await evaluatePrompt(spec, this.deployment.catalogue, { model, scope: row.scope_id, ...(row.user_id !== null && { user: row.user_id }), thread: { id: row.thread_id }, tools: [], now: new Date() });
      const { messages } = prepareMessages(transcriptFromEvents(this.read(0, "part", Number.MAX_SAFE_INTEGER)), { provider: profile.adapter, model: native });
      const request = {
        model: native,
        config: profile,
        ...(system !== undefined && { system }),
        messages,
        ...(spec.model.params && { params: spec.model.params }),
        ...((profile.providerOptions || spec.model.providerOptions) && { providerOptions: { ...profile.providerOptions, ...spec.model.providerOptions } }),
      };
      for await (const event of provider.stream(request, { fetch, signal: new AbortController().signal })) {
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
      return stepError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** A Turn's last event; `TestThread.send` and the loop both key on it. */
export type TurnEnd = ThreadEventData & { type: "turn.completed" | "turn.failed" | "turn.paused" };

export function isTurnEnd(event: ThreadEventData): event is TurnEnd {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused";
}

const failure = (reason: string, message: string): TurnEnd => ({ type: "turn.failed", reason, message });
const stepError = (message: string): StepResult => ({ ok: false, error: { code: "unknown", message, retryable: false } });

function resolveProfile(spec: AgentSpec, providers: Record<string, ProviderConfig>): ProviderConfig | undefined {
  const name = spec.model.providerProfile ?? (Object.keys(providers).length === 1 ? Object.keys(providers)[0] : undefined);
  return name === undefined ? undefined : providers[name];
}

function addUsage(total: Usage, usage: Usage): Usage {
  return { input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite };
}
