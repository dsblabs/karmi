import { ScheduledDurableObject } from "./scheduler";
import type { NormalizedAgentSpec } from "./agent-spec";
import type { AgentSpec } from "./agent";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { fail, ok, type Outcome } from "./outcome";
import type { Envelope } from "./envelope";
import type { McpCatalog } from "./mcp-catalog";
import { parseScopeConfig, resolveScopeConfig, type ScopeConfigDocument } from "./scope-config";
import type { CredentialInfo } from "./secrets";
import { encodeKey, type ThreadSummary } from "./thread";
import { validateAgentSpec, type ValidationResult } from "./validate";

// One Durable Object per Scope, named `{scope}/config` (keys.ts). Its SQLite holds the config revisions, the
// Agent Spec versions and the lifecycle state; the Scope handle (scope.ts) is the only caller.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scope_head (scope_id TEXT PRIMARY KEY, state TEXT NOT NULL, current_revision INTEGER NOT NULL, destroy_operation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scope_revisions (revision INTEGER PRIMARY KEY, config_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_specs (agent_id TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, catalogue_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, version));
  CREATE TABLE IF NOT EXISTS agent_heads (agent_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE IF NOT EXISTS destroy_operations (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cursor_json TEXT);
  CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, title TEXT);
  CREATE INDEX IF NOT EXISTS threads_by_agent_user ON threads (agent_id, user_id, last_active_at);
  CREATE TABLE IF NOT EXISTS connections (agent_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, name));
  CREATE TABLE IF NOT EXISTS provider_credentials (name TEXT PRIMARY KEY, version INTEGER NOT NULL, kek TEXT, dek TEXT, ciphertext TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS mcp_catalog (server_id TEXT NOT NULL, partition TEXT NOT NULL, catalog_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, partition));
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

/** What a Thread reports about itself when its Turn snapshots; the index row is created or touched from it. */
export interface ThreadActivity {
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
  /** Deployment defaults merged under the Scope revision; secret-free by construction. */
  config: ScopeConfigDocument;
}

/** A stored Scope credential as the envelope store reads it: metadata plus the envelope, gone once revoked. */
export interface StoredCredential extends CredentialInfo {
  name: string;
  envelope?: Envelope;
}

export type { Outcome } from "./outcome";

// The one decode point for each JSON column this Durable Object writes; both are validated before they are stored.
const decodeConfig = (json: string): ScopeConfigDocument => JSON.parse(json);
/** JSON carries no explicit `undefined`, so a stored normalized Spec is also a plain `AgentSpec`. */
const decodeSpec = (json: string): NormalizedAgentSpec & AgentSpec => JSON.parse(json);
const decodeCatalog = (json: string): McpCatalog => JSON.parse(json);

/** Which cached MCP catalogue: one server, one credential partition. */
export interface McpCatalogKey {
  serverId: string;
  partition: string;
}

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

export abstract class ScopeConfigDurableObject extends ScheduledDurableObject {
  abstract readonly deployment: Deployment;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Every entry point: the row appears on first use, and once destruction started nothing else may enter
  // except the lifecycle reads that report on it.
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
      // Only a keys.ts bug can get here; refusing is what keeps it from becoming a cross-Scope bug.
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
    // Awaited first so validation, the CAS check and the writes below run without yielding in between.
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
   * The Scope side of a Turn snapshot. A code-defined Agent is seeded on first use; a stored Spec whose
   * Catalogue changed is revalidated before it may run again. The Thread index row is created or touched here.
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
    return ok({
      state: head.value.state,
      agent: agent.value,
      config: resolveScopeConfig(this.deployment.defaults, this.document(head.value.current_revision)),
    });
  }

  /** Threads of an Agent, most recently active first; `user` narrows to one User, `null` to user-less Threads. */
  threadForget(scope: ScopeId, threadId: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.sql.exec("DELETE FROM threads WHERE thread_id = ?", threadId);
    return ok(undefined);
  }

  threadsList(scope: ScopeId, agent: string, user?: string | null): Outcome<ThreadSummary[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const rows =
      user === undefined
        ? this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE agent_id = ? ORDER BY last_active_at DESC", agent)
        : this.sql.exec<ThreadRow>(
            "SELECT * FROM threads WHERE agent_id = ? AND user_id IS ? ORDER BY last_active_at DESC",
            agent,
            user,
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
          key: encodeKey(identity),
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
          ...(row.title !== null && { title: row.title }),
        };
      }),
    );
  }

  // Agent-level Connection values: set through a write-only API, read only by a Turn at call time,
  // never part of a Spec, a snapshot or a listing.
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

  connectionsList(scope: ScopeId, agentId: string): Outcome<{ name: string; updatedAt: number }[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.sql
        .exec<{ name: string; updated_at: number }>(
          "SELECT name, updated_at FROM connections WHERE agent_id = ? ORDER BY name",
          agentId,
        )
        .toArray()
        .map((row) => ({ name: row.name, updatedAt: row.updated_at })),
    );
  }

  connectionGet(scope: ScopeId, agentId: string, name: string): Outcome<unknown> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.sql
      .exec<{ value_json: string }>("SELECT value_json FROM connections WHERE agent_id = ? AND name = ?", agentId, name)
      .toArray()[0];
    return ok(row ? JSON.parse(row.value_json) : undefined);
  }

  // The envelope store's rows: ciphertext and wrapped keys only. Sealing and opening happen in the
  // envelope SecretsProvider, so this object never sees a value or the keyring.
  credentialGet(scope: ScopeId, name: string): Outcome<StoredCredential | undefined> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.sql.exec<CredentialRow>("SELECT * FROM provider_credentials WHERE name = ?", name).toArray()[0];
    return ok(row && decodeCredential(row));
  }

  /** Stores `version`, which must follow the stored one, so a put sealed against a stale version never lands. */
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

  /** Drops the wrapped DEK and ciphertext; the row stays so the version keeps counting and `describe` says revoked. */
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

  /** Swaps the envelope of one version in place; a concurrent put or revoke makes it a no-op. */
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

  // The MCP catalogue cache: one `tools/list` per (server, partition), refreshed by whoever holds the
  // credentials to fetch it; this object only stores what it is handed.
  mcpCatalogGet(scope: ScopeId, keys: McpCatalogKey[]): Outcome<(McpCatalog | undefined)[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      keys.map(({ serverId, partition }) => {
        const row = this.sql
          .exec<{ catalog_json: string }>(
            "SELECT catalog_json FROM mcp_catalog WHERE server_id = ? AND partition = ?",
            serverId,
            partition,
          )
          .toArray()[0];
        return row && decodeCatalog(row.catalog_json);
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

  // The tombstone, the operation row and the credential wipe land in one transaction, so a destroy can
  // never half-happen: once the Scope is destroying, no credential of its own can be opened again.
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
        "INSERT INTO destroy_operations (operation_id, state, started_at, updated_at) VALUES (?, 'destroying', ?, ?)",
        operationId,
        now,
        now,
      );
      this.sql.exec("DELETE FROM provider_credentials");
      this.sql.exec("DELETE FROM mcp_catalog");
    });
    return ok({ operationId });
  }

  // The walk that empties the Scope lands with wayfinder #67; until then an operation stays "destroying".
  destroyStatus(scope: ScopeId, operationId: string): Outcome<DestroyStatus> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
    if (!head.ok) return head;
    const row = this.sql
      .exec<{ state: DestroyStatus["state"] }>(
        "SELECT state FROM destroy_operations WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    if (!row)
      return fail(new KarmiError("destroy.notFound", `No destroy operation "${operationId}" in Scope "${scope}".`));
    return ok({ operationId, state: row.state });
  }
}
