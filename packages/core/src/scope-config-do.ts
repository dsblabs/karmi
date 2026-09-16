import { ScheduledDurableObject, type ScheduledJob } from "./scheduler";
import type { NormalizedAgentSpec } from "./agent-spec";
import type { AgentSpec } from "./agent";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { fail, ok, type Outcome } from "./outcome";
import type { Envelope } from "./envelope";
import type { McpCatalog } from "./mcp-catalog";
import { mcpHolder, resolveHolder, tokenFresh, type McpHolder, type McpHolderRef } from "./mcp-auth";
import {
  beginAuthorization,
  completeAuthorization,
  GrantProvider,
  refreshGrant,
  type PreregisteredClient,
} from "./mcp-oauth";
import { isHolder, listGrants, OAUTH_SCHEMA, readPending, SqlGrantStore } from "./mcp-oauth-store";
import { parseScopeConfig, resolveScopeConfig, type McpServerConfig, type ScopeConfigDocument } from "./scope-config";
import { decodeCursor, destroyStep, startCursor, type DestroyProgress, type ExternalCleanup } from "./scope-destroy";
import { matchesHost, scopedFetch } from "./scoped-fetch";
import type { CredentialInfo } from "./secrets";
import { encodeKey, type ThreadIdentity, type ThreadSummary } from "./thread";
import { validateAgentSpec, type ValidationResult } from "./validate";

// This module is the Durable Object every Scope has one of, named `{scope}/config` (keys.ts). Its SQLite
// holds the config revisions, the Agent Spec versions, the credential rows, the OAuth grants and the
// lifecycle state. The Scope handle (scope.ts) is the only caller.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scope_head (scope_id TEXT PRIMARY KEY, state TEXT NOT NULL, current_revision INTEGER NOT NULL, destroy_operation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scope_revisions (revision INTEGER PRIMARY KEY, config_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_specs (agent_id TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, catalogue_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, version));
  CREATE TABLE IF NOT EXISTS agent_heads (agent_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE IF NOT EXISTS destroy_operations (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cursor_json TEXT);
  CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, title TEXT);
  CREATE INDEX IF NOT EXISTS threads_by_agent_user ON threads (agent_id, user_id, last_active_at);
  CREATE TABLE IF NOT EXISTS thread_parents (thread_id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, call_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS thread_parents_by_parent ON thread_parents (thread_key);
  CREATE TABLE IF NOT EXISTS connections (agent_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, name));
  CREATE TABLE IF NOT EXISTS provider_credentials (name TEXT PRIMARY KEY, version INTEGER NOT NULL, kek TEXT, dek TEXT, ciphertext TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS mcp_catalog (server_id TEXT NOT NULL, partition TEXT NOT NULL, catalog_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, partition));
  CREATE TABLE IF NOT EXISTS user_connections (user_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, name));
  CREATE TABLE IF NOT EXISTS knowledge_names (name TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS memory_users (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`;

/** The id of the single maintenance job a destroy walk re-arms until the Scope is empty. */
const DESTROY_JOB = "scope-maintenance";

/** The payload of the maintenance job: which Scope the walk empties, under which operation. */
function decodeMaintenance(payload: unknown): { scope: ScopeId; operationId: string } {
  return payload as { scope: ScopeId; operationId: string };
}

/** The number of versions kept per Agent. A put drops older ones. */
export const AGENT_HISTORY_DEPTH = 20;

/** The lifecycle state of a Scope. Suspension is reversible and destruction is not. */
export type ScopeState = "active" | "suspended" | "destroying" | "destroyed";

/** A Scope config document with the revision it was stored as. */
export interface ConfigRecord {
  revision: number;
  document: ScopeConfigDocument;
}

/** One stored version of an Agent Spec. */
export interface AgentRecord {
  agentId: string;
  version: number;
  spec: NormalizedAgentSpec;
  createdAt: number;
  /** Whether the Catalogue changed since this version was validated. A new put revalidates it. */
  catalogueChanged: boolean;
}

/** An Agent as `scope.agents.list` reports it: its current version and display fields. */
export interface AgentSummary {
  agentId: string;
  version: number;
  name: string;
  description?: string;
  updatedAt: number;
}

/** One entry of an Agent's version history. */
export interface AgentVersion {
  version: number;
  createdAt: number;
}

/** The lifecycle state of a Scope and its current config revision. */
export interface ScopeStatus {
  state: ScopeState;
  configRevision: number;
}

/** The progress of one destroy operation. */
export interface DestroyStatus {
  operationId: string;
  /** Whether the maintenance walk is still running or the Scope is empty. */
  state: "destroying" | "destroyed";
  /** What the walk is deleting now and how much of the Scope it has removed. */
  progress: DestroyProgress;
  /** What was asked of a Secrets provider karmi does not own, absent when it owns the Scope's credentials. */
  externalCleanup?: ExternalCleanup;
}

/**
 * What a Thread reports about itself when its Turn snapshots. The Thread index row is created or touched from
 * it.
 */
export interface ThreadActivity {
  parent?: import("./delegation").ParentLink;
  threadId: string;
  userId?: string;
  createdAt: number;
  activeAt: number;
  title?: string;
}

/** Everything a Turn needs from the Scope, resolved once at its first Step. */
export interface TurnSnapshotSource {
  state: ScopeState;
  agent: AgentRecord;
  /** The Scope revision resolved over the Deployment defaults. It holds no secrets. */
  config: ScopeConfigDocument;
}

/**
 * A stored Scope credential as the envelope store reads it: the metadata plus the Envelope, which revoke
 * removes.
 */
export interface StoredCredential extends CredentialInfo {
  name: string;
  envelope?: Envelope;
}

export type { Outcome } from "./outcome";

// These are the decode points for the JSON columns this Durable Object writes. Every value is validated
// before it is stored, so decoding does not validate again.
const decodeConfig = (json: string): ScopeConfigDocument => JSON.parse(json);
// JSON carries no explicit `undefined`, so a stored normalized Spec is also a plain `AgentSpec`.
const decodeSpec = (json: string): NormalizedAgentSpec & AgentSpec => JSON.parse(json);
const decodeCatalog = (json: string): McpCatalog => JSON.parse(json);

/** The key of one cached MCP catalogue: a server and a credential Partition. */
export interface McpCatalogKey {
  serverId: string;
  partition: string;
}

/** An access token as it leaves this object, for one Turn in memory. It never carries the refresh token. */
export interface McpGrantView {
  token: string;
  expiresAt?: number;
  scope?: string;
}

/** The input to `mcpAuthorize`: the Holder and server, plus what the callback should do afterwards. */
export interface McpAuthorizeInput extends McpHolderRef {
  /** The Thread whose Parked Step the callback wakes. */
  thread?: ThreadIdentity;
  /** The OAuth scopes to request, replacing the server's configured ones. A Step-up passes the union. */
  scope?: string;
  /** The URL the callback sends the browser to afterwards. */
  returnTo?: string;
}

/** The query parameters the OAuth callback route receives. */
export interface McpCallbackInput {
  /** The state nonce that identifies the pending authorization. */
  nonce: string;
  /** The authorization code, present on success. */
  code?: string;
  /** The issuer the server identifies itself as. */
  iss?: string;
  /** The server's error code, present on failure. */
  error?: string;
}

/** What `mcpCallback` reports: which pending authorization completed, and whether it was granted. */
export interface McpCallbackResult {
  serverId: string;
  holder: McpHolder;
  /** The Thread whose Parked Step the callback wakes. */
  thread?: ThreadIdentity;
  /** The URL the callback sends the browser to afterwards. */
  returnTo?: string;
  /** Whether the grant was stored, or why not: the server's error or the exchange's failure. */
  outcome: ConnectOutcome;
}

/** Whether a consent flow ended in a stored grant, with the reason when it did not. */
export type ConnectOutcome = { granted: true } | { granted: false; reason: string };

type PendingInput = ConstructorParameters<typeof SqlGrantStore>[3];

/** The access token view of a grant. It never carries the refresh token. */
function grantView(grant: { accessToken: string; expiresAt?: number; scope?: string }): McpGrantView {
  return {
    token: grant.accessToken,
    ...(grant.expiresAt !== undefined && { expiresAt: grant.expiresAt }),
    ...(grant.scope !== undefined && { scope: grant.scope }),
  };
}

type OAuthServer = {
  id: string;
  config: McpServerConfig;
  auth: Extract<NonNullable<McpServerConfig["auth"]>, { type: "oauth" }>;
  identity: NonNullable<Deployment["oauth"]>;
};

export { isHolder };

const notFound = (agentId: string) =>
  fail(new KarmiError("agent.notFound", `Agent "${agentId}" does not exist in this Scope.`));

type HeadRow = {
  scope_id: string;
  state: ScopeState;
  current_revision: number;
  destroy_operation_id: string | null;
};

type ThreadRow = {
  thread_id: string;
  agent_id: string;
  user_id: string | null;
  created_at: number;
  last_active_at: number;
  title: string | null;
};

type CredentialRow = {
  name: string;
  version: number;
  kek: string | null;
  dek: string | null;
  ciphertext: string | null;
  updated_at: number;
  revoked_at: number | null;
};

const decodeCredential = (row: CredentialRow): StoredCredential => ({
  name: row.name,
  source: "scope",
  version: row.version,
  updatedAt: row.updated_at,
  ...(row.revoked_at !== null && { revokedAt: row.revoked_at }),
  ...(row.kek !== null &&
    row.dek !== null &&
    row.ciphertext !== null && { envelope: { kek: row.kek, dek: row.dek, ciphertext: row.ciphertext } }),
});

type AgentHeadRow = {
  agent_id: string;
  current_version: number;
  deleted_at: number | null;
};

/**
 * The Durable Object behind one Scope. It stores the config revisions, Agent Spec versions, Connection
 * values, credential rows, OAuth grants, MCP catalogue cache and lifecycle state. Every method returns an
 * Outcome and `scope.ts` is the only caller.
 */
export abstract class ScopeConfigDurableObject extends ScheduledDurableObject {
  abstract readonly deployment: Deployment;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    ctx.storage.sql.exec(OAUTH_SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Refreshes in flight by `server/holder`. Concurrent Turns share one token request so they never race a
  // rotation.
  private readonly refreshing = new Map<string, Promise<Outcome<McpGrantView | undefined>>>();

  // Every entry point calls this first. The head row appears on first use. Once destruction has started,
  // only the lifecycle reads that report on it may enter.
  private enter(scope: ScopeId, refuseDestroyed = true): Outcome<HeadRow> {
    let head = this.sql.exec<HeadRow>("SELECT * FROM scope_head").toArray()[0];
    if (!head) {
      const now = this.deployment.clock.now();
      this.sql.exec(
        "INSERT INTO scope_head (scope_id, state, current_revision, created_at, updated_at) VALUES (?, 'active', 0, ?, ?)",
        scope,
        now,
        now,
      );
      head = { scope_id: scope, state: "active", current_revision: 0, destroy_operation_id: null };
    } else if (head.scope_id !== scope) {
      // Only a keys.ts bug can get here. Refusing keeps it from becoming a cross-Scope bug.
      throw new Error(`ScopeConfig for "${head.scope_id}" was addressed as "${scope}".`);
    }
    if (refuseDestroyed && (head.state === "destroying" || head.state === "destroyed"))
      return fail(new KarmiError("scope.destroyed", `Scope "${scope}" has been destroyed.`));
    return ok(head);
  }

  private setState(state: ScopeState): void {
    this.sql.exec("UPDATE scope_head SET state = ?, updated_at = ?", state, this.deployment.clock.now());
  }

  private document(revision: number): ScopeConfigDocument {
    if (revision === 0) return {};
    const row = this.sql
      .exec<{ config_json: string }>("SELECT config_json FROM scope_revisions WHERE revision = ?", revision)
      .one();
    return decodeConfig(row.config_json);
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
      parsed = parseScopeConfig(document, this.deployment.providers, this.deployment.defaults.providers ?? {});
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
    const current = head.value.current_revision;
    if (ifRevision !== undefined && ifRevision !== current)
      return fail(new KarmiError("config.conflict", `Scope config is at revision ${current}, not ${ifRevision}.`));
    const revision = current + 1;
    const now = this.deployment.clock.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO scope_revisions (revision, config_json, created_at) VALUES (?, ?, ?)",
        revision,
        JSON.stringify(parsed),
        now,
      );
      this.sql.exec("UPDATE scope_head SET current_revision = ?, updated_at = ?", revision, now);
    });
    return ok({ revision });
  }

  private agentHead(agentId: string): AgentHeadRow | undefined {
    return this.sql.exec<AgentHeadRow>("SELECT * FROM agent_heads WHERE agent_id = ?", agentId).toArray()[0];
  }

  private validate(head: HeadRow, spec: unknown): ValidationResult {
    const agents = this.sql
      .exec<{ agent_id: string; spec_json: string }>(
        "SELECT h.agent_id, s.spec_json FROM agent_heads h JOIN agent_specs s ON s.agent_id = h.agent_id AND s.version = h.current_version WHERE h.deleted_at IS NULL",
      )
      .toArray()
      .map((row) => ({ agentId: row.agent_id, spec: decodeSpec(row.spec_json) }));
    const config = resolveScopeConfig(this.deployment.defaults, this.document(head.current_revision));
    return validateAgentSpec(spec, this.deployment.catalogue, {
      config,
      agents,
      deploymentProviders: this.deployment.defaults.providers ?? {},
      loaderAvailable: this.env.KARMI_LOADER !== undefined,
    });
  }

  agentsValidate(scope: ScopeId, spec: unknown): Outcome<ValidationResult> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(this.validate(head.value, spec));
  }

  async agentsPut(
    scope: ScopeId,
    spec: unknown,
    ifVersion?: number,
  ): Promise<Outcome<{ agentId: string; version: number }>> {
    // The fingerprint is awaited first so validation, the compare-and-set check and the writes below run
    // without yielding in between.
    const fingerprint = await this.deployment.catalogue.fingerprint();
    const head = this.enter(scope);
    if (!head.ok) return head;
    return this.store(head.value, spec, fingerprint, ifVersion);
  }

  private store(
    head: HeadRow,
    spec: unknown,
    fingerprint: string,
    ifVersion?: number,
  ): Outcome<{ agentId: string; version: number }> {
    const result = this.validate(head, spec);
    if (!result.ok) return { ok: false, code: "agent.spec.invalid", message: "Agent Spec is invalid.", result };
    const normalized = result.normalized;
    return this.ctx.storage.transactionSync(() => {
      const current = this.agentHead(normalized.agentId)?.current_version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current)
        return fail(
          new KarmiError("agent.conflict", `Agent "${normalized.agentId}" is at version ${current}, not ${ifVersion}.`),
        );
      const version = current + 1;
      this.sql.exec(
        "INSERT INTO agent_specs (agent_id, version, spec_json, catalogue_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)",
        normalized.agentId,
        version,
        JSON.stringify(normalized),
        fingerprint,
        this.deployment.clock.now(),
      );
      this.sql.exec(
        "INSERT INTO agent_heads (agent_id, current_version, deleted_at) VALUES (?, ?, NULL) ON CONFLICT (agent_id) DO UPDATE SET current_version = excluded.current_version, deleted_at = NULL",
        normalized.agentId,
        version,
      );
      this.sql.exec(
        "DELETE FROM agent_specs WHERE agent_id = ? AND version <= ?",
        normalized.agentId,
        version - AGENT_HISTORY_DEPTH,
      );
      return ok({ agentId: normalized.agentId, version });
    });
  }

  async agentsGet(scope: ScopeId, agentId: string, version?: number): Promise<Outcome<AgentRecord>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return notFound(agentId);
    if (version === undefined && agent.deleted_at !== null)
      return fail(new KarmiError("agent.deleted", `Agent "${agentId}" has been deleted.`));
    const wanted = version ?? agent.current_version;
    const row = this.sql
      .exec<{ spec_json: string; catalogue_fingerprint: string; created_at: number }>(
        "SELECT spec_json, catalogue_fingerprint, created_at FROM agent_specs WHERE agent_id = ? AND version = ?",
        agentId,
        wanted,
      )
      .toArray()[0];
    if (!row) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" has no version ${wanted}.`));
    const fingerprint = await this.deployment.catalogue.fingerprint();
    return ok({
      agentId,
      version: wanted,
      spec: decodeSpec(row.spec_json),
      createdAt: row.created_at,
      catalogueChanged: row.catalogue_fingerprint !== fingerprint,
    });
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
        const spec = decodeSpec(row.spec_json);
        return {
          agentId: row.agent_id,
          version: row.version,
          name: spec.name,
          ...(spec.description !== undefined && { description: spec.description }),
          updatedAt: row.created_at,
        };
      }),
    );
  }

  agentsHistory(scope: ScopeId, agentId: string): Outcome<AgentVersion[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    if (!this.agentHead(agentId)) return notFound(agentId);
    const rows = this.sql
      .exec<{ version: number; created_at: number }>(
        "SELECT version, created_at FROM agent_specs WHERE agent_id = ? ORDER BY version",
        agentId,
      )
      .toArray();
    return ok(rows.map((row) => ({ version: row.version, createdAt: row.created_at })));
  }

  agentsDelete(scope: ScopeId, agentId: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return notFound(agentId);
    if (agent.deleted_at === null)
      this.sql.exec("UPDATE agent_heads SET deleted_at = ? WHERE agent_id = ?", this.deployment.clock.now(), agentId);
    return ok(undefined);
  }

  /**
   * The Scope side of a Turn snapshot. A code-defined Agent is seeded on first use. A stored Spec whose
   * Catalogue changed is revalidated before it may run again. The Thread index row is created or touched
   * here.
   */
  async turnSnapshot(scope: ScopeId, agentId: string, thread: ThreadActivity): Promise<Outcome<TurnSnapshotSource>> {
    const fingerprint = await this.deployment.catalogue.fingerprint();
    const head = this.enter(scope);
    if (!head.ok) return head;
    if (!this.agentHead(agentId)) {
      const defined = this.deployment.catalogue.agents.get(agentId);
      if (!defined) return notFound(agentId);
      const seeded = this.store(head.value, defined.spec, fingerprint, 0);
      if (!seeded.ok) return seeded;
    }
    const agent = await this.agentsGet(scope, agentId);
    if (!agent.ok) return agent;
    if (agent.value.catalogueChanged) {
      const result = this.validate(head.value, agent.value.spec);
      if (!result.ok)
        return {
          ok: false,
          code: "agent.spec.invalid",
          message: `Agent "${agentId}" no longer validates against the Catalogue.`,
          result,
        };
    }
    this.sql.exec(
      "INSERT INTO threads (thread_id, agent_id, user_id, created_at, last_active_at, title) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET last_active_at = excluded.last_active_at, title = COALESCE(threads.title, excluded.title)",
      thread.threadId,
      agentId,
      thread.userId ?? null,
      thread.createdAt,
      thread.activeAt,
      thread.title ?? null,
    );
    if (thread.parent)
      this.sql.exec(
        "INSERT OR IGNORE INTO thread_parents (thread_id, thread_key, call_id) VALUES (?, ?, ?)",
        thread.threadId,
        thread.parent.threadKey,
        thread.parent.callId,
      );
    return ok({
      state: head.value.state,
      agent: agent.value,
      config: resolveScopeConfig(this.deployment.defaults, this.document(head.value.current_revision)),
    });
  }

  /** Removes a Thread from the index. */
  threadForget(scope: ScopeId, threadId: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM threads WHERE thread_id = ?", threadId);
    this.sql.exec("DELETE FROM thread_parents WHERE thread_id = ?", threadId);
    return ok(undefined);
  }

  /**
   * The Threads of an Agent, most recently active first. `user` narrows to one User and `null` to Threads
   * without a User.
   */
  threadsList(scope: ScopeId, agent: string, user?: string | null, parent?: string | null): Outcome<ThreadSummary[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const conditions = ["t.agent_id = ?"];
    const values: (string | null)[] = [agent];
    if (user !== undefined) {
      conditions.push("t.user_id IS ?");
      values.push(user);
    }
    if (parent !== undefined) {
      conditions.push("p.thread_key IS ?");
      values.push(parent);
    }
    const rows = this.sql.exec<ThreadRow & { thread_key: string | null; call_id: string | null }>(
      `SELECT t.*, p.thread_key, p.call_id FROM threads t
       LEFT JOIN thread_parents p ON p.thread_id = t.thread_id
       WHERE ${conditions.join(" AND ")} ORDER BY t.last_active_at DESC`,
      ...values,
    );
    return ok(
      rows.toArray().map((row) => {
        const identity = {
          agent: row.agent_id,
          threadId: row.thread_id,
          ...(row.user_id !== null && { user: row.user_id }),
        };
        return {
          ...identity,
          ...(row.thread_key !== null &&
            row.call_id !== null && { parent: { threadKey: row.thread_key, callId: row.call_id } }),
          key: encodeKey(identity),
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
          ...(row.title !== null && { title: row.title }),
        };
      }),
    );
  }

  // Agent-level Connection values are set through a write-only API and read only by a Turn at call time.
  // They are never part of a Spec, a snapshot or a listing.
  connectionsSet(scope: ScopeId, agentId: string, name: string, value: unknown): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    if (!this.agentHead(agentId) && !this.deployment.catalogue.agents.has(agentId)) return notFound(agentId);
    this.sql.exec(
      "INSERT INTO connections (agent_id, name, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      agentId,
      name,
      JSON.stringify(value),
      this.deployment.clock.now(),
    );
    return ok(undefined);
  }

  connectionsDelete(scope: ScopeId, agentId: string, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM connections WHERE agent_id = ? AND name = ?", agentId, name);
    return ok(undefined);
  }

  /** The set Connection values, followed by the OAuth grants this Agent holds as `mcp:<serverId>`. */
  connectionsList(scope: ScopeId, agentId: string): Outcome<{ name: string; updatedAt: number }[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok([
      ...this.sql
        .exec<{ name: string; updated_at: number }>(
          "SELECT name, updated_at FROM connections WHERE agent_id = ? ORDER BY name",
          agentId,
        )
        .toArray()
        .map((row) => ({ name: row.name, updatedAt: row.updated_at })),
      ...listGrants(this.sql, mcpHolder("agent", agentId, undefined) ?? "agent:"),
    ]);
  }

  // User-level Connection values are keyed by (User, name). They are the User's own grants, usable by
  // every Agent of the Scope.
  userConnectionSet(scope: ScopeId, user: string, name: string, value: unknown): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec(
      "INSERT INTO user_connections (user_id, name, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      user,
      name,
      JSON.stringify(value),
      this.deployment.clock.now(),
    );
    return ok(undefined);
  }

  userConnectionDelete(scope: ScopeId, user: string, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM user_connections WHERE user_id = ? AND name = ?", user, name);
    return ok(undefined);
  }

  userConnectionsList(scope: ScopeId, user: string): Outcome<{ name: string; updatedAt: number }[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok([
      ...this.sql
        .exec<{ name: string; updated_at: number }>(
          "SELECT name, updated_at FROM user_connections WHERE user_id = ? ORDER BY name",
          user,
        )
        .toArray()
        .map((row) => ({ name: row.name, updatedAt: row.updated_at })),
      ...listGrants(this.sql, mcpHolder("user", undefined, user) ?? "user:"),
    ]);
  }

  /** Lists the Knowledge corpora in this Scope. */
  knowledgeList(scope: ScopeId): Outcome<string[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.sql
        .exec<{ name: string }>("SELECT name FROM knowledge_names ORDER BY name")
        .toArray()
        .map((row) => row.name),
    );
  }

  /** Registers a corpus before its first durable write. */
  knowledgeAdd(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec("INSERT OR IGNORE INTO knowledge_names VALUES (?)", name);
    return ok(undefined);
  }

  /** Removes an emptied corpus from the Scope index. */
  knowledgeRemove(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM knowledge_names WHERE name = ?", name);
    return ok(undefined);
  }

  /** The Users with a Memory in this Scope, in id order. */
  memoryUsersList(scope: ScopeId): Outcome<string[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.sql
        .exec<{ user_id: string }>("SELECT user_id FROM memory_users ORDER BY user_id")
        .toArray()
        .map((row) => row.user_id),
    );
  }

  /** Adds a User to the Memory index. A Turn calls it before every write to the User's Memory. */
  memoryUsersAdd(scope: ScopeId, user: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec(
      "INSERT OR IGNORE INTO memory_users (user_id, created_at) VALUES (?, ?)",
      user,
      this.deployment.clock.now(),
    );
    return ok(undefined);
  }

  /** Removes a User from the Memory index. `scope.users.memory.delete` calls it before clearing the Memory. */
  memoryUsersRemove(scope: ScopeId, user: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM memory_users WHERE user_id = ?", user);
    return ok(undefined);
  }

  userConnectionGet(scope: ScopeId, user: string, name: string): Outcome<unknown> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM user_connections WHERE user_id = ? AND name = ?",
        user,
        name,
      )
      .toArray()[0];
    return ok(row ? JSON.parse(row.value_json) : undefined);
  }

  // The OAuth grants for MCP servers. This object is the only one that talks to an authorization server.
  // It holds the refresh tokens, mints and redeems pending authorizations, and hands out access tokens
  // only.
  private oauthServer(head: HeadRow, serverId: string): Outcome<OAuthServer> {
    const config = resolveScopeConfig(this.deployment.defaults, this.document(head.current_revision));
    const server = config.mcp?.servers?.[serverId];
    if (!server)
      return fail(new KarmiError("mcp.server.unknown", `No MCP server "${serverId}" is registered in this Scope.`));
    if (server.auth?.type !== "oauth")
      return fail(new KarmiError("mcp.oauth.notOAuth", `MCP server "${serverId}" is not configured for OAuth.`));
    const identity = this.deployment.oauth;
    if (!identity)
      return fail(
        new KarmiError(
          "mcp.oauth.unconfigured",
          `MCP server "${serverId}" uses OAuth, but createKarmi({ oauth }) names no client identity for this Deployment.`,
        ),
      );
    const host = new URL(server.url).hostname.toLowerCase();
    const allowed = config.egress?.mcpHosts;
    if (allowed && !allowed.some((pattern) => matchesHost(host, pattern)))
      return fail(
        new KarmiError("config.invalid", `MCP server "${serverId}" is outside this Scope's egress.mcpHosts.`),
      );
    return ok({ id: serverId, config: server, auth: server.auth, identity });
  }

  private grantStore(scope: ScopeId, server: OAuthServer, holder: McpHolder, pending?: PendingInput): SqlGrantStore {
    return new SqlGrantStore(
      { sql: this.sql, clock: this.deployment.clock, secrets: this.deployment.secrets, scope },
      server.id,
      holder,
      pending,
    );
  }

  private async grantProvider(
    scope: ScopeId,
    server: OAuthServer,
    store: SqlGrantStore,
  ): Promise<Outcome<GrantProvider>> {
    const preregistered = await this.preregistered(scope, server);
    if (!preregistered.ok) return preregistered;
    return ok(
      new GrantProvider({
        scope,
        identity: server.identity,
        store,
        now: () => this.deployment.clock.now(),
        ...(preregistered.value && { preregistered: preregistered.value }),
      }),
    );
  }

  private async preregistered(scope: ScopeId, server: OAuthServer): Promise<Outcome<PreregisteredClient | undefined>> {
    const { client } = server.auth;
    if (!client) return ok(undefined);
    if (client.secret === undefined) return ok({ client_id: client.id });
    const secret = await this.deployment.secrets.resolve({ scope, ref: client.secret });
    if (!secret)
      return fail(
        new KarmiError(
          "mcp.oauth.failed",
          `MCP server "${server.id}": the client secret "${client.secret}" is missing from the SecretsProvider.`,
        ),
      );
    return ok({ client_id: client.id, client_secret: secret.value.expose() });
  }

  private flow(scope: ScopeId, server: OAuthServer, provider: GrantProvider) {
    return {
      provider,
      serverId: server.id,
      serverUrl: server.config.url,
      // Only the SSRF guard applies, because the authorization server's host is discovered, not registered.
      fetch: scopedFetch({ fetch: this.deployment.fetch }),
    };
  }

  /**
   * The Holder's access token for one server, or undefined when there is no grant. The token is refreshed
   * first when it is about to expire or when the caller's `usedToken` was refused. A caller whose token
   * another Turn already rotated gets the current one back. Concurrent refreshes of one grant share a
   * single request.
   */
  async mcpRefresh(
    scope: ScopeId,
    serverId: string,
    holder: McpHolder,
    usedToken?: string,
  ): Promise<Outcome<McpGrantView | undefined>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const server = this.oauthServer(head.value, serverId);
    if (!server.ok) return server;
    const store = this.grantStore(scope, server.value, holder);
    const current = store.grant();
    if (!current) return ok(undefined);
    const stale =
      usedToken !== undefined
        ? current.accessToken === usedToken
        : !tokenFresh(current.expiresAt, this.deployment.clock.now());
    if (!stale) return ok(grantView(current));
    const key = `${serverId}/${holder}`;
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const work = this.refresh(scope, server.value, store).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, work);
    return work;
  }

  private async refresh(
    scope: ScopeId,
    server: OAuthServer,
    store: SqlGrantStore,
  ): Promise<Outcome<McpGrantView | undefined>> {
    const provider = await this.grantProvider(scope, server, store);
    if (!provider.ok) return provider;
    try {
      const refreshed = await refreshGrant(this.flow(scope, server, provider.value));
      const grant = store.grant();
      return ok(refreshed && grant ? grantView(grant) : undefined);
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
  }

  /** Starts a consent flow and returns the URL the human must visit. The callback arrives at `mcpCallback`. */
  async mcpAuthorize(scope: ScopeId, input: McpAuthorizeInput): Promise<Outcome<{ authUrl: string }>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const server = this.oauthServer(head.value, input.serverId);
    if (!server.ok) return server;
    const holder = resolveHolder(server.value.auth, input);
    if (!holder.ok) return fail(holder.error);
    const store = this.grantStore(scope, server.value, holder.holder, {
      ...(input.user !== undefined && { user: input.user }),
      ...(input.thread && { thread: input.thread }),
      ...(input.returnTo !== undefined && { returnTo: input.returnTo }),
    });
    const provider = await this.grantProvider(scope, server.value, store);
    if (!provider.ok) return provider;
    try {
      const url = await beginAuthorization(
        this.flow(scope, server.value, provider.value),
        input.scope ?? server.value.auth.scope,
      );
      return ok({ authUrl: url.href });
    } catch (error) {
      if (error instanceof KarmiError) return fail(error);
      throw error;
    }
  }

  /** Completes the consent flow. It redeems the code under the pending authorization and stores the grant. */
  async mcpCallback(scope: ScopeId, input: McpCallbackInput): Promise<Outcome<McpCallbackResult>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const pending = readPending(this.sql, input.nonce, this.deployment.clock.now());
    if (!pending)
      return fail(new KarmiError("mcp.oauth.state", "This authorization is unknown or has expired; start it again."));
    const server = this.oauthServer(head.value, pending.serverId);
    if (!server.ok) return server;
    const store = this.grantStore(scope, server.value, pending.holder, { nonce: pending.nonce });
    const provider = await this.grantProvider(scope, server.value, store);
    if (!provider.ok) return provider;
    const result = (outcome: ConnectOutcome): McpCallbackResult => ({
      serverId: pending.serverId,
      holder: pending.holder,
      ...(pending.thread && { thread: pending.thread }),
      ...(pending.returnTo !== undefined && { returnTo: pending.returnTo }),
      outcome,
    });
    try {
      if (input.code === undefined)
        return ok(result({ granted: false, reason: input.error ?? "The authorization server sent no code." }));
      await completeAuthorization(this.flow(scope, server.value, provider.value), input.code, input.iss);
      return ok(result({ granted: true }));
    } catch (error) {
      if (error instanceof KarmiError) return ok(result({ granted: false, reason: error.message }));
      throw error;
    } finally {
      store.dropPending();
    }
  }

  /** Drops the Holder's grant and the private catalogue cached under it. A public catalogue is kept. */
  mcpDisconnect(scope: ScopeId, serverId: string, holder: McpHolder): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const server = this.oauthServer(head.value, serverId);
    if (!server.ok) return server;
    this.ctx.storage.transactionSync(() => {
      this.grantStore(scope, server.value, holder).dropGrant();
      this.sql.exec(
        "DELETE FROM mcp_catalog WHERE server_id = ? AND partition = ? AND json_extract(catalog_json, '$.cacheScope') = 'private'",
        serverId,
        holder,
      );
    });
    return ok(undefined);
  }

  connectionGet(scope: ScopeId, agentId: string, name: string): Outcome<unknown> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.sql
      .exec<{ value_json: string }>("SELECT value_json FROM connections WHERE agent_id = ? AND name = ?", agentId, name)
      .toArray()[0];
    return ok(row ? JSON.parse(row.value_json) : undefined);
  }

  // The envelope store's rows hold ciphertext and wrapped keys only. Sealing and opening happen in the
  // envelope Secrets provider, so this object never sees a value or the key ring.
  credentialGet(scope: ScopeId, name: string): Outcome<StoredCredential | undefined> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.sql.exec<CredentialRow>("SELECT * FROM provider_credentials WHERE name = ?", name).toArray()[0];
    return ok(row && decodeCredential(row));
  }

  /**
   * Stores `envelope` as `version`, which must follow the stored version. A put sealed against a stale version
   * fails.
   */
  credentialPut(scope: ScopeId, name: string, version: number, envelope: Envelope): Outcome<CredentialInfo> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const now = this.deployment.clock.now();
    return this.ctx.storage.transactionSync(() => {
      const current =
        this.sql.exec<{ version: number }>("SELECT version FROM provider_credentials WHERE name = ?", name).toArray()[0]
          ?.version ?? 0;
      if (version !== current + 1)
        return fail(
          new KarmiError("credential.conflict", `Credential "${name}" is at version ${current}; retry the put.`),
        );
      this.sql.exec(
        "INSERT INTO provider_credentials (name, version, kek, dek, ciphertext, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (name) DO UPDATE SET version = excluded.version, kek = excluded.kek, dek = excluded.dek, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, revoked_at = NULL",
        name,
        version,
        envelope.kek,
        envelope.dek,
        envelope.ciphertext,
        now,
        now,
      );
      return ok({ source: "scope", version, updatedAt: now });
    });
  }

  /**
   * Drops the wrapped data key and ciphertext. The row stays so the version keeps counting and `describe`
   * reports it revoked.
   */
  credentialRevoke(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec(
      "UPDATE provider_credentials SET kek = NULL, dek = NULL, ciphertext = NULL, revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
      this.deployment.clock.now(),
      name,
    );
    return ok(undefined);
  }

  credentialList(scope: ScopeId): Outcome<StoredCredential[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.sql.exec<CredentialRow>("SELECT * FROM provider_credentials ORDER BY name").toArray().map(decodeCredential),
    );
  }

  /**
   * Swaps the Envelope of one version in place. Returns false when a concurrent put or revoke changed the row.
   */
  credentialRewrap(scope: ScopeId, name: string, version: number, envelope: Envelope): Outcome<boolean> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const changed = this.sql.exec(
      "UPDATE provider_credentials SET kek = ?, dek = ?, ciphertext = ? WHERE name = ? AND version = ? AND revoked_at IS NULL AND kek != ?",
      envelope.kek,
      envelope.dek,
      envelope.ciphertext,
      name,
      version,
      envelope.kek,
    ).rowsWritten;
    return ok(changed > 0);
  }

  // The MCP catalogue cache holds one `tools/list` per (server, Partition). The caller that holds the
  // credentials fetches it. This object only stores what it is handed.
  /**
   * The cached catalogue for each key. A Partition without a catalogue of its own reads the `public`
   * one, so a Turn without a grant still sees the tools.
   */
  mcpCatalogGet(scope: ScopeId, keys: McpCatalogKey[]): Outcome<(McpCatalog | undefined)[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      keys.map(({ serverId, partition }) => {
        const rows = this.sql
          .exec<{ partition: string; catalog_json: string }>(
            "SELECT partition, catalog_json FROM mcp_catalog WHERE server_id = ? ORDER BY updated_at DESC",
            serverId,
          )
          .toArray();
        const own = rows.find((row) => row.partition === partition);
        if (own) return decodeCatalog(own.catalog_json);
        return rows.map((row) => decodeCatalog(row.catalog_json)).find((catalog) => catalog.cacheScope === "public");
      }),
    );
  }

  mcpCatalogPut(scope: ScopeId, key: McpCatalogKey, catalog: McpCatalog): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.sql.exec(
      "INSERT INTO mcp_catalog (server_id, partition, catalog_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (server_id, partition) DO UPDATE SET catalog_json = excluded.catalog_json, updated_at = excluded.updated_at",
      key.serverId,
      key.partition,
      JSON.stringify(catalog),
      this.deployment.clock.now(),
    );
    return ok(undefined);
  }

  status(scope: ScopeId): Outcome<ScopeStatus> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
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

  // The Tombstone, the operation row and the credential wipe are written in one transaction so a destroy
  // cannot half-happen. Once the Scope is destroying, none of its credentials can be opened again.
  destroy(scope: ScopeId): Outcome<{ operationId: string }> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
    if (!head.ok) return head;
    if (head.value.destroy_operation_id !== null) return ok({ operationId: head.value.destroy_operation_id });
    const operationId = crypto.randomUUID();
    const now = this.deployment.clock.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE scope_head SET state = 'destroying', destroy_operation_id = ?, updated_at = ?",
        operationId,
        now,
      );
      this.sql.exec(
        "INSERT INTO destroy_operations (operation_id, state, started_at, updated_at, cursor_json) VALUES (?, 'destroying', ?, ?, ?)",
        operationId,
        now,
        now,
        JSON.stringify(startCursor()),
      );
      this.sql.exec("DELETE FROM provider_credentials");
      this.sql.exec("DELETE FROM mcp_catalog");
      this.sql.exec("DELETE FROM mcp_grants");
      this.sql.exec("DELETE FROM mcp_clients");
      this.sql.exec("DELETE FROM mcp_oauth_state");
      this.sql.exec("DELETE FROM user_connections");
    });
    this.scheduleWalk(scope, operationId);
    return ok({ operationId });
  }

  // The walk runs on this object's alarm, one batch per firing, and re-arms itself until the Scope is empty.
  private scheduleWalk(scope: ScopeId, operationId: string): void {
    this.scheduler.set({
      id: DESTROY_JOB,
      kind: "scope-maintenance",
      dueAt: this.deployment.clock.now(),
      payload: { scope, operationId },
    });
  }

  protected override async runJob(job: ScheduledJob): Promise<void> {
    if (job.kind !== "scope-maintenance") return super.runJob(job);
    const { scope, operationId } = decodeMaintenance(job.payload);
    const row = this.sql
      .exec<{ state: DestroyStatus["state"]; cursor_json: string | null }>(
        "SELECT state, cursor_json FROM destroy_operations WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    // A late alarm for an operation that has already finished has nothing left to delete.
    if (!row || row.state === "destroyed") return;
    const cursor = await destroyStep(
      { scope, deployment: this.deployment, bindings: this.env, sql: this.sql, attempt: job.attempt },
      decodeCursor(row.cursor_json),
    );
    const done = cursor.progress.phase === "done";
    this.sql.exec(
      "UPDATE destroy_operations SET cursor_json = ?, state = ?, updated_at = ? WHERE operation_id = ?",
      JSON.stringify(cursor),
      done ? "destroyed" : "destroying",
      this.deployment.clock.now(),
      operationId,
    );
    if (done) this.setState("destroyed");
    else this.scheduleWalk(scope, operationId);
  }

  /** The state of the destroy operation `operationId`. Throws `destroy.notFound` when there is none. */
  destroyStatus(scope: ScopeId, operationId: string): Outcome<DestroyStatus> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
    if (!head.ok) return head;
    const row = this.sql
      .exec<{ state: DestroyStatus["state"]; cursor_json: string | null }>(
        "SELECT state, cursor_json FROM destroy_operations WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    if (!row)
      return fail(new KarmiError("destroy.notFound", `No destroy operation "${operationId}" in Scope "${scope}".`));
    const { progress, external } = decodeCursor(row.cursor_json);
    return ok({ operationId, state: row.state, progress, ...(external && { externalCleanup: external }) });
  }
}
