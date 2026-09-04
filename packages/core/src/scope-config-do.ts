import { DurableObject } from "cloudflare:workers";
import type { NormalizedAgentSpec } from "./agent-spec.js";
import type { AgentSpec } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import type { ScopeId } from "./context.js";
import type { Deployment } from "./deployment.js";
import { KarmiError } from "./errors.js";
import { parseScopeConfig, resolveScopeConfig, type ScopeConfigDocument } from "./scope-config.js";
import { validateAgentSpec, type ValidationResult } from "./validate.js";

// One Durable Object per Scope, named `{scope}/config` (keys.ts). Its SQLite holds the config revisions, the
// Agent Spec versions and the lifecycle state; the Scope handle (scope.ts) is the only caller.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scope_head (scope_id TEXT PRIMARY KEY, state TEXT NOT NULL, current_revision INTEGER NOT NULL, destroy_operation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scope_revisions (revision INTEGER PRIMARY KEY, config_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_specs (agent_id TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, catalogue_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, version));
  CREATE TABLE IF NOT EXISTS agent_heads (agent_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE IF NOT EXISTS destroy_operations (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cursor_json TEXT);
`;

/** Versions kept per Agent; older ones are dropped on put. */
export const AGENT_HISTORY_DEPTH = 20;

export type ScopeState = "active" | "suspended" | "destroying" | "destroyed";

export interface ConfigRecord {
  revision: number;
  document: ScopeConfigDocument;
}

export interface AgentRecord {
  agentId: string;
  version: number;
  spec: NormalizedAgentSpec;
  createdAt: number;
  /** The Catalogue changed since this version was validated; re-put to revalidate. */
  catalogueChanged: boolean;
}

export interface AgentSummary {
  agentId: string;
  version: number;
  name: string;
  description?: string;
  updatedAt: number;
}

export interface AgentVersion {
  version: number;
  createdAt: number;
}

export interface ScopeStatus {
  state: ScopeState;
  configRevision: number;
}

export interface DestroyStatus {
  operationId: string;
  state: "destroying" | "destroyed";
}

/**
 * Workers RPC keeps only an Error's message, so every method reports failure as data and the handle
 * rethrows it as a `KarmiError` (or `SpecInvalidError` when `result` is present).
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string; result?: ValidationResult };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (error: KarmiError): Outcome<never> => ({ ok: false, code: error.code, message: error.message });

type HeadRow = {
  scope_id: string;
  state: ScopeState;
  current_revision: number;
  destroy_operation_id: string | null;
};

type AgentHeadRow = {
  agent_id: string;
  current_version: number;
  deleted_at: number | null;
};

export abstract class ScopeConfigDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Every entry point: the row appears on first use, and once destruction started nothing else may enter.
  private enter(scope: ScopeId, entry = true): Outcome<HeadRow> {
    let head = this.sql.exec<HeadRow>("SELECT * FROM scope_head").toArray()[0];
    if (!head) {
      const now = Date.now();
      this.sql.exec("INSERT INTO scope_head (scope_id, state, current_revision, created_at, updated_at) VALUES (?, 'active', 0, ?, ?)", scope, now, now);
      head = { scope_id: scope, state: "active", current_revision: 0, destroy_operation_id: null };
    } else if (head.scope_id !== scope) {
      // Only a keys.ts bug can get here; refusing is what keeps it from becoming a cross-Scope bug.
      throw new Error(`ScopeConfig for "${head.scope_id}" was addressed as "${scope}".`);
    }
    if (entry && (head.state === "destroying" || head.state === "destroyed")) return fail(new KarmiError("scope.destroyed", `Scope "${scope}" has been destroyed.`));
    return ok(head);
  }

  private setState(state: ScopeState): void {
    this.sql.exec("UPDATE scope_head SET state = ?, updated_at = ?", state, Date.now());
  }

  private document(revision: number): ScopeConfigDocument {
    if (revision === 0) return {};
    const row = this.sql.exec<{ config_json: string }>("SELECT config_json FROM scope_revisions WHERE revision = ?", revision).one();
    return JSON.parse(row.config_json) as ScopeConfigDocument;
  }

  configGet(scope: ScopeId): Outcome<ConfigRecord> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok({ revision: head.value.current_revision, document: this.document(head.value.current_revision) });
  }

  configSet(scope: ScopeId, document: unknown, ifRevision?: number): Outcome<{ revision: number }> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    let parsed: ScopeConfigDocument;
    try {
      parsed = parseScopeConfig(document, this.deployment.providers);
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
    const current = head.value.current_revision;
    if (ifRevision !== undefined && ifRevision !== current) return fail(new KarmiError("config.conflict", `Scope config is at revision ${current}, not ${ifRevision}.`));
    const revision = current + 1;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO scope_revisions (revision, config_json, created_at) VALUES (?, ?, ?)", revision, JSON.stringify(parsed), now);
      this.sql.exec("UPDATE scope_head SET current_revision = ?, updated_at = ?", revision, now);
    });
    return ok({ revision });
  }

  private agentHead(agentId: string): AgentHeadRow | undefined {
    return this.sql.exec<AgentHeadRow>("SELECT * FROM agent_heads WHERE agent_id = ?", agentId).toArray()[0];
  }

  private validate(head: HeadRow, spec: unknown): ValidationResult {
    const agents = this.sql
      .exec<{ agent_id: string; spec_json: string }>("SELECT h.agent_id, s.spec_json FROM agent_heads h JOIN agent_specs s ON s.agent_id = h.agent_id AND s.version = h.current_version WHERE h.deleted_at IS NULL")
      .toArray()
      .map((row) => ({ agentId: row.agent_id, spec: JSON.parse(row.spec_json) as AgentSpec }));
    const config = resolveScopeConfig(this.deployment.defaults, this.document(head.current_revision));
    return validateAgentSpec(spec, this.deployment.catalogue, { config, agents });
  }

  agentsValidate(scope: ScopeId, spec: unknown): Outcome<ValidationResult> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(this.validate(head.value, spec));
  }

  async agentsPut(scope: ScopeId, spec: unknown, ifVersion?: number): Promise<Outcome<{ agentId: string; version: number }>> {
    // Awaited first so validation, the CAS check and the writes below run without yielding in between.
    const fingerprint = await this.deployment.catalogue.fingerprint();
    const head = this.enter(scope);
    if (!head.ok) return head;
    const result = this.validate(head.value, spec);
    if (!result.normalized) return { ok: false, code: "agent.spec.invalid", message: "Agent Spec is invalid.", result };
    const normalized = result.normalized;
    return this.ctx.storage.transactionSync(() => {
      const current = this.agentHead(normalized.agentId)?.current_version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) return fail(new KarmiError("agent.conflict", `Agent "${normalized.agentId}" is at version ${current}, not ${ifVersion}.`));
      const version = current + 1;
      this.sql.exec("INSERT INTO agent_specs (agent_id, version, spec_json, catalogue_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)", normalized.agentId, version, JSON.stringify(normalized), fingerprint, Date.now());
      this.sql.exec("INSERT INTO agent_heads (agent_id, current_version, deleted_at) VALUES (?, ?, NULL) ON CONFLICT (agent_id) DO UPDATE SET current_version = excluded.current_version, deleted_at = NULL", normalized.agentId, version);
      this.sql.exec("DELETE FROM agent_specs WHERE agent_id = ? AND version <= ?", normalized.agentId, version - AGENT_HISTORY_DEPTH);
      return ok({ agentId: normalized.agentId, version });
    });
  }

  async agentsGet(scope: ScopeId, agentId: string, version?: number): Promise<Outcome<AgentRecord>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" does not exist in this Scope.`));
    if (version === undefined && agent.deleted_at !== null) return fail(new KarmiError("agent.deleted", `Agent "${agentId}" has been deleted.`));
    const wanted = version ?? agent.current_version;
    const row = this.sql
      .exec<{ spec_json: string; catalogue_fingerprint: string; created_at: number }>("SELECT spec_json, catalogue_fingerprint, created_at FROM agent_specs WHERE agent_id = ? AND version = ?", agentId, wanted)
      .toArray()[0];
    if (!row) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" has no version ${wanted}.`));
    const fingerprint = await this.deployment.catalogue.fingerprint();
    return ok({ agentId, version: wanted, spec: JSON.parse(row.spec_json) as NormalizedAgentSpec, createdAt: row.created_at, catalogueChanged: row.catalogue_fingerprint !== fingerprint });
  }

  agentsList(scope: ScopeId): Outcome<AgentSummary[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const rows = this.sql
      .exec<{ agent_id: string; version: number; spec_json: string; created_at: number }>(
        "SELECT h.agent_id, h.current_version AS version, s.spec_json, s.created_at FROM agent_heads h JOIN agent_specs s ON s.agent_id = h.agent_id AND s.version = h.current_version WHERE h.deleted_at IS NULL ORDER BY h.agent_id",
      )
      .toArray();
    return ok(
      rows.map((row) => {
        const spec = JSON.parse(row.spec_json) as NormalizedAgentSpec;
        return { agentId: row.agent_id, version: row.version, name: spec.name, ...(spec.description !== undefined && { description: spec.description }), updatedAt: row.created_at };
      }),
    );
  }

  agentsHistory(scope: ScopeId, agentId: string): Outcome<AgentVersion[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    if (!this.agentHead(agentId)) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" does not exist in this Scope.`));
    const rows = this.sql.exec<{ version: number; created_at: number }>("SELECT version, created_at FROM agent_specs WHERE agent_id = ? ORDER BY version", agentId).toArray();
    return ok(rows.map((row) => ({ version: row.version, createdAt: row.created_at })));
  }

  agentsDelete(scope: ScopeId, agentId: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" does not exist in this Scope.`));
    if (agent.deleted_at === null) this.sql.exec("UPDATE agent_heads SET deleted_at = ? WHERE agent_id = ?", Date.now(), agentId);
    return ok(undefined);
  }

  status(scope: ScopeId): Outcome<ScopeStatus> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    return ok({ state: head.value.state, configRevision: head.value.current_revision });
  }

  suspend(scope: ScopeId): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.setState("suspended");
    return ok(undefined);
  }

  resume(scope: ScopeId): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.setState("active");
    return ok(undefined);
  }

  // The tombstone and the operation row land in one transaction, so a destroy can never half-happen.
  destroy(scope: ScopeId): Outcome<{ operationId: string }> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    if (head.value.destroy_operation_id !== null) return ok({ operationId: head.value.destroy_operation_id });
    const operationId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE scope_head SET state = 'destroying', destroy_operation_id = ?, updated_at = ?", operationId, now);
      this.sql.exec("INSERT INTO destroy_operations (operation_id, state, started_at, updated_at) VALUES (?, 'destroying', ?, ?)", operationId, now, now);
    });
    return ok({ operationId });
  }

  // The walk that empties the Scope lands with wayfinder #67; until then an operation stays "destroying".
  destroyStatus(scope: ScopeId, operationId: string): Outcome<DestroyStatus> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    const row = this.sql.exec<{ state: DestroyStatus["state"] }>("SELECT state FROM destroy_operations WHERE operation_id = ?", operationId).toArray()[0];
    if (!row) return fail(new KarmiError("destroy.notFound", `No destroy operation "${operationId}" in Scope "${scope}".`));
    return ok({ operationId, state: row.state });
  }
}
