import { and, asc, count, desc, eq, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { ScheduledDurableObject, type ScheduledAlarm } from "./scheduler";
import type { AgentSpec } from "./agent";
import type { NormalizedAgentSpec } from "./agent-spec";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import scopeConfigMigrations from "./db/scope-config/migrations";
import {
  agentHeads,
  agentSpecs,
  connections,
  containerLeases,
  destroyOperations,
  knowledgeNames,
  mcpCatalog,
  memoryUsers,
  providerCredentials,
  scopeConfigSchema,
  scopeHead,
  scopeRevisions,
  threadParents,
  threads,
  userConnections,
  type ScopeConfigDatabase,
} from "./db/scope-config/schema";
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
import { isHolder, listGrants, readPending, SqlGrantStore } from "./mcp-oauth-store";
import { parseScopeConfig, resolveScopeConfig, type McpServerConfig, type ScopeConfigDocument } from "./scope-config";
import {
  decodeCursor,
  destroyStep,
  startCursor,
  TOMBSTONE_TABLES,
  type DestroyProgress,
  type ExternalCleanup,
} from "./scope-destroy";
import { matchesHost, scopedFetch } from "./scoped-fetch";
import type { CredentialInfo } from "./secrets";
import { encodeKey, type ThreadIdentity, type ThreadSummary } from "./thread";
import { validateAgentSpec, type ValidationResult } from "./validate";

// This module is the Durable Object every Scope has one of, named `{scope}/config` (keys.ts). Its SQLite
// holds the config revisions, the Agent Spec versions, the credential rows, the OAuth grants and the
// lifecycle state. The Scope handle (scope.ts) is the only caller.

/** The id of the single maintenance Alarm a destroy walk re-arms until the Scope is empty. */
const DESTROY_ALARM = "scope-maintenance";

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

type HeadRow = typeof scopeHead.$inferSelect;
type AgentHeadRow = typeof agentHeads.$inferSelect;
type CredentialRow = typeof providerCredentials.$inferSelect;

const decodeCredential = (row: CredentialRow): StoredCredential => ({
  name: row.name,
  source: "scope",
  version: row.version,
  updatedAt: row.updatedAt,
  ...(row.revokedAt !== null && { revokedAt: row.revokedAt }),
  ...(row.kek !== null &&
    row.dek !== null &&
    row.ciphertext !== null && { envelope: { kek: row.kek, dek: row.dek, ciphertext: row.ciphertext } }),
});

// The join condition that pairs each Agent head with its current Spec version.
const currentSpec = and(eq(agentSpecs.agentId, agentHeads.agentId), eq(agentSpecs.version, agentHeads.currentVersion));

/**
 * The Durable Object behind one Scope. It stores the config revisions, Agent Spec versions, Connection
 * values, credential rows, OAuth grants, MCP catalogue cache and lifecycle state. Every method returns an
 * Outcome and `scope.ts` is the only caller.
 */
export abstract class ScopeConfigDurableObject extends ScheduledDurableObject {
  abstract readonly deployment: Deployment;
  private readonly db: ScopeConfigDatabase;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: scopeConfigSchema });
    ctx.blockConcurrencyWhile(() => migrate(this.db, scopeConfigMigrations));
  }

  // Refreshes in flight by `server/holder`. Concurrent Turns share one token request so they never race a
  // rotation.
  private readonly refreshing = new Map<string, Promise<Outcome<McpGrantView | undefined>>>();

  // Every entry point calls this first. The head row appears on first use. Once destruction has started,
  // only the lifecycle reads that report on it may enter.
  private enter(scope: ScopeId, refuseDestroyed = true): Outcome<HeadRow> {
    let head = this.db.select().from(scopeHead).get();
    if (!head) {
      const now = this.deployment.clock.now();
      head = {
        scopeId: scope,
        state: "active",
        currentRevision: 0,
        destroyOperationId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.db.insert(scopeHead).values(head).run();
    } else if (head.scopeId !== scope) {
      // Only a keys.ts bug can get here. Refusing keeps it from becoming a cross-Scope bug.
      throw new Error(`ScopeConfig for "${head.scopeId}" was addressed as "${scope}".`);
    }
    if (refuseDestroyed && (head.state === "destroying" || head.state === "destroyed"))
      return fail(new KarmiError("scope.destroyed", `Scope "${scope}" has been destroyed.`));
    return ok(head);
  }

  private setState(state: ScopeState): void {
    this.db.update(scopeHead).set({ state, updatedAt: this.deployment.clock.now() }).run();
  }

  private document(revision: number): ScopeConfigDocument {
    if (revision === 0) return {};
    const row = this.db
      .select({ config: scopeRevisions.config })
      .from(scopeRevisions)
      .where(eq(scopeRevisions.revision, revision))
      .get();
    if (!row) throw new Error(`Scope config revision ${revision} is missing.`);
    return row.config;
  }

  /** Reserves one Workspace slot until the Thread confirms its destruction. */
  reserveContainer(scope: ScopeId, threadId: string): Outcome<void> {
    const entered = this.enter(scope);
    if (!entered.ok) return entered;
    const config = resolveScopeConfig(this.deployment.defaults, this.document(entered.value.currentRevision));
    const ceiling = config.ceilings?.scripts;
    const max = ceiling === false ? 0 : (ceiling?.maxContainers ?? Number.MAX_SAFE_INTEGER);

    const exists = this.db.select().from(containerLeases).where(eq(containerLeases.threadId, threadId)).get();
    const leases = this.db.select({ leases: count() }).from(containerLeases).get()?.leases ?? 0;
    if (!exists && leases >= max)
      return fail(new KarmiError("scope.limit", "The Scope maxContainers ceiling was reached."));
    this.db.insert(containerLeases).values({ threadId }).onConflictDoNothing().run();
    return ok(undefined);
  }

  /** Releases a destroyed Thread Workspace's Scope reservation. */
  releaseContainer(scope: ScopeId, threadId: string): Outcome<void> {
    const entered = this.enter(scope, false);
    if (!entered.ok) return entered;
    this.db.delete(containerLeases).where(eq(containerLeases.threadId, threadId)).run();
    return ok(undefined);
  }

  /** Reads the current Scope config document. */
  configGet(scope: ScopeId): Outcome<ConfigRecord> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok({ revision: head.value.currentRevision, document: this.document(head.value.currentRevision) });
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
    const current = head.value.currentRevision;
    if (ifRevision !== undefined && ifRevision !== current)
      return fail(new KarmiError("config.conflict", `Scope config is at revision ${current}, not ${ifRevision}.`));
    const revision = current + 1;
    const now = this.deployment.clock.now();
    this.db.transaction((tx) => {
      tx.insert(scopeRevisions).values({ revision, config: parsed, createdAt: now }).run();
      tx.update(scopeHead).set({ currentRevision: revision, updatedAt: now }).run();
    });
    return ok({ revision });
  }

  private agentHead(agentId: string): AgentHeadRow | undefined {
    return this.db.select().from(agentHeads).where(eq(agentHeads.agentId, agentId)).get();
  }

  private validate(head: HeadRow, spec: unknown): ValidationResult {
    const agents = this.db
      .select({ agentId: agentHeads.agentId, spec: agentSpecs.spec })
      .from(agentHeads)
      .innerJoin(agentSpecs, currentSpec)
      .where(isNull(agentHeads.deletedAt))
      .all()
      // JSON carries no explicit `undefined`, so a stored normalized Spec is also a plain `AgentSpec`.
      .map((row) => ({ agentId: row.agentId, spec: row.spec as NormalizedAgentSpec & AgentSpec }));
    const config = resolveScopeConfig(this.deployment.defaults, this.document(head.currentRevision));
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
    const { agentId } = normalized;
    return this.db.transaction((tx) => {
      const current =
        tx.select({ version: agentHeads.currentVersion }).from(agentHeads).where(eq(agentHeads.agentId, agentId)).get()
          ?.version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current)
        return fail(new KarmiError("agent.conflict", `Agent "${agentId}" is at version ${current}, not ${ifVersion}.`));
      const version = current + 1;
      tx.insert(agentSpecs)
        .values({
          agentId,
          version,
          spec: normalized,
          catalogueFingerprint: fingerprint,
          createdAt: this.deployment.clock.now(),
        })
        .run();
      tx.insert(agentHeads)
        .values({ agentId, currentVersion: version, deletedAt: null })
        .onConflictDoUpdate({ target: agentHeads.agentId, set: { currentVersion: version, deletedAt: null } })
        .run();
      tx.delete(agentSpecs)
        .where(and(eq(agentSpecs.agentId, agentId), lte(agentSpecs.version, version - AGENT_HISTORY_DEPTH)))
        .run();
      return ok({ agentId, version });
    });
  }

  async agentsGet(scope: ScopeId, agentId: string, version?: number): Promise<Outcome<AgentRecord>> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return notFound(agentId);
    if (version === undefined && agent.deletedAt !== null)
      return fail(new KarmiError("agent.deleted", `Agent "${agentId}" has been deleted.`));
    const wanted = version ?? agent.currentVersion;
    const row = this.db
      .select()
      .from(agentSpecs)
      .where(and(eq(agentSpecs.agentId, agentId), eq(agentSpecs.version, wanted)))
      .get();
    if (!row) return fail(new KarmiError("agent.notFound", `Agent "${agentId}" has no version ${wanted}.`));
    const fingerprint = await this.deployment.catalogue.fingerprint();
    return ok({
      agentId,
      version: wanted,
      spec: row.spec,
      createdAt: row.createdAt,
      catalogueChanged: row.catalogueFingerprint !== fingerprint,
    });
  }

  agentsList(scope: ScopeId): Outcome<AgentSummary[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const rows = this.db
      .select({
        agentId: agentHeads.agentId,
        version: agentHeads.currentVersion,
        spec: agentSpecs.spec,
        createdAt: agentSpecs.createdAt,
      })
      .from(agentHeads)
      .innerJoin(agentSpecs, currentSpec)
      .where(isNull(agentHeads.deletedAt))
      .orderBy(asc(agentHeads.agentId))
      .all();
    return ok(
      rows.map(({ agentId, version, spec, createdAt }) => ({
        agentId,
        version,
        name: spec.name,
        ...(spec.description !== undefined && { description: spec.description }),
        updatedAt: createdAt,
      })),
    );
  }

  agentsHistory(scope: ScopeId, agentId: string): Outcome<AgentVersion[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    if (!this.agentHead(agentId)) return notFound(agentId);
    return ok(
      this.db
        .select({ version: agentSpecs.version, createdAt: agentSpecs.createdAt })
        .from(agentSpecs)
        .where(eq(agentSpecs.agentId, agentId))
        .orderBy(asc(agentSpecs.version))
        .all(),
    );
  }

  agentsDelete(scope: ScopeId, agentId: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const agent = this.agentHead(agentId);
    if (!agent) return notFound(agentId);
    if (agent.deletedAt === null)
      this.db
        .update(agentHeads)
        .set({ deletedAt: this.deployment.clock.now() })
        .where(eq(agentHeads.agentId, agentId))
        .run();
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
    this.indexThread(agentId, thread);
    return ok({
      state: head.value.state,
      agent: agent.value,
      config: resolveScopeConfig(this.deployment.defaults, this.document(head.value.currentRevision)),
    });
  }

  /** Registers an attached Thread so Scope destruction can close it even before its first Turn. */
  threadAttach(scope: ScopeId, agentId: string, thread: ThreadActivity): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.indexThread(agentId, thread);
    return ok(undefined);
  }

  private indexThread(agentId: string, thread: ThreadActivity): void {
    const title = thread.title ?? null;
    this.db
      .insert(threads)
      .values({
        threadId: thread.threadId,
        agentId,
        userId: thread.userId ?? null,
        createdAt: thread.createdAt,
        lastActiveAt: thread.activeAt,
        title,
      })
      .onConflictDoUpdate({
        target: threads.threadId,
        set: { lastActiveAt: thread.activeAt, title: sql`coalesce(${threads.title}, ${title})` },
      })
      .run();
    if (thread.parent)
      this.db
        .insert(threadParents)
        .values({ threadId: thread.threadId, threadKey: thread.parent.threadKey, callId: thread.parent.callId })
        .onConflictDoNothing()
        .run();
  }

  /** Removes a Thread from the index. */
  threadForget(scope: ScopeId, threadId: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.db.delete(threads).where(eq(threads.threadId, threadId)).run();
    this.db.delete(threadParents).where(eq(threadParents.threadId, threadId)).run();
    return ok(undefined);
  }

  /**
   * The Threads of an Agent, most recently active first. `user` narrows to one User and `null` to Threads
   * without a User.
   */
  threadsList(scope: ScopeId, agent: string, user?: string | null, parent?: string | null): Outcome<ThreadSummary[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const conditions: SQL[] = [eq(threads.agentId, agent)];
    if (user !== undefined) conditions.push(user === null ? isNull(threads.userId) : eq(threads.userId, user));
    if (parent !== undefined)
      conditions.push(parent === null ? isNull(threadParents.threadKey) : eq(threadParents.threadKey, parent));
    const rows = this.db
      .select({ thread: threads, threadKey: threadParents.threadKey, callId: threadParents.callId })
      .from(threads)
      .leftJoin(threadParents, eq(threadParents.threadId, threads.threadId))
      .where(and(...conditions))
      .orderBy(desc(threads.lastActiveAt))
      .all();
    return ok(
      rows.map(({ thread, threadKey, callId }) => {
        const identity = {
          agent: thread.agentId,
          threadId: thread.threadId,
          ...(thread.userId !== null && { user: thread.userId }),
        };
        return {
          ...identity,
          ...(threadKey !== null && callId !== null && { parent: { threadKey, callId } }),
          key: encodeKey(identity),
          createdAt: thread.createdAt,
          lastActiveAt: thread.lastActiveAt,
          ...(thread.title !== null && { title: thread.title }),
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
    const updatedAt = this.deployment.clock.now();
    this.db
      .insert(connections)
      .values({ agentId, name, value, updatedAt })
      .onConflictDoUpdate({ target: [connections.agentId, connections.name], set: { value, updatedAt } })
      .run();
    return ok(undefined);
  }

  connectionsDelete(scope: ScopeId, agentId: string, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.db.delete(connections).where(this.connectionKey(agentId, name)).run();
    return ok(undefined);
  }

  /** The set Connection values, followed by the OAuth grants this Agent holds as `mcp:<serverId>`. */
  connectionsList(scope: ScopeId, agentId: string): Outcome<{ name: string; updatedAt: number }[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok([
      ...this.db
        .select({ name: connections.name, updatedAt: connections.updatedAt })
        .from(connections)
        .where(eq(connections.agentId, agentId))
        .orderBy(asc(connections.name))
        .all(),
      ...listGrants(this.db, mcpHolder("agent", agentId, undefined) ?? "agent:"),
    ]);
  }

  // User-level Connection values are keyed by (User, name). They are the User's own grants, usable by
  // every Agent of the Scope.
  userConnectionSet(scope: ScopeId, user: string, name: string, value: unknown): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const updatedAt = this.deployment.clock.now();
    this.db
      .insert(userConnections)
      .values({ userId: user, name, value, updatedAt })
      .onConflictDoUpdate({ target: [userConnections.userId, userConnections.name], set: { value, updatedAt } })
      .run();
    return ok(undefined);
  }

  userConnectionDelete(scope: ScopeId, user: string, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.db.delete(userConnections).where(this.userConnectionKey(user, name)).run();
    return ok(undefined);
  }

  userConnectionsList(scope: ScopeId, user: string): Outcome<{ name: string; updatedAt: number }[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok([
      ...this.db
        .select({ name: userConnections.name, updatedAt: userConnections.updatedAt })
        .from(userConnections)
        .where(eq(userConnections.userId, user))
        .orderBy(asc(userConnections.name))
        .all(),
      ...listGrants(this.db, mcpHolder("user", undefined, user) ?? "user:"),
    ]);
  }

  /** Lists the Knowledge corpora in this Scope. */
  knowledgeList(scope: ScopeId): Outcome<string[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.db
        .select()
        .from(knowledgeNames)
        .orderBy(asc(knowledgeNames.name))
        .all()
        .map((row) => row.name),
    );
  }

  /** Registers a corpus before its first durable write. */
  knowledgeAdd(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.db.insert(knowledgeNames).values({ name }).onConflictDoNothing().run();
    return ok(undefined);
  }

  /** Removes an emptied corpus from the Scope index. */
  knowledgeRemove(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.db.delete(knowledgeNames).where(eq(knowledgeNames.name, name)).run();
    return ok(undefined);
  }

  /** The Users with a Memory in this Scope, in id order. */
  memoryUsersList(scope: ScopeId): Outcome<string[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.db
        .select({ userId: memoryUsers.userId })
        .from(memoryUsers)
        .orderBy(asc(memoryUsers.userId))
        .all()
        .map((row) => row.userId),
    );
  }

  /** Adds a User to the Memory index. A Turn calls it before every write to the User's Memory. */
  memoryUsersAdd(scope: ScopeId, user: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.db
      .insert(memoryUsers)
      .values({ userId: user, createdAt: this.deployment.clock.now() })
      .onConflictDoNothing()
      .run();
    return ok(undefined);
  }

  /** Removes a User from the Memory index. `scope.users.memory.delete` calls it before clearing the Memory. */
  memoryUsersRemove(scope: ScopeId, user: string): Outcome<void> {
    const head = this.enter(scope, false);
    if (!head.ok) return head;
    this.db.delete(memoryUsers).where(eq(memoryUsers.userId, user)).run();
    return ok(undefined);
  }

  userConnectionGet(scope: ScopeId, user: string, name: string): Outcome<unknown> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.db
      .select({ value: userConnections.value })
      .from(userConnections)
      .where(this.userConnectionKey(user, name))
      .get();
    return ok(row?.value);
  }

  // The OAuth grants for MCP servers. This object is the only one that talks to an authorization server.
  // It holds the refresh tokens, mints and redeems pending authorizations, and hands out access tokens
  // only.
  private oauthServer(head: HeadRow, serverId: string): Outcome<OAuthServer> {
    const config = resolveScopeConfig(this.deployment.defaults, this.document(head.currentRevision));
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
      { db: this.db, clock: this.deployment.clock, secrets: this.deployment.secrets, scope },
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
    const pending = readPending(this.db, input.nonce, this.deployment.clock.now());
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
    this.db.transaction((tx) => {
      this.grantStore(scope, server.value, holder).dropGrant();
      tx.delete(mcpCatalog)
        .where(
          and(
            eq(mcpCatalog.serverId, serverId),
            eq(mcpCatalog.partition, holder),
            sql`json_extract(${mcpCatalog.catalog}, '$.cacheScope') = 'private'`,
          ),
        )
        .run();
    });
    return ok(undefined);
  }

  connectionGet(scope: ScopeId, agentId: string, name: string): Outcome<unknown> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.db
      .select({ value: connections.value })
      .from(connections)
      .where(this.connectionKey(agentId, name))
      .get();
    return ok(row?.value);
  }

  private connectionKey(agentId: string, name: string): SQL | undefined {
    return and(eq(connections.agentId, agentId), eq(connections.name, name));
  }

  private userConnectionKey(user: string, name: string): SQL | undefined {
    return and(eq(userConnections.userId, user), eq(userConnections.name, name));
  }

  // The envelope store's rows hold ciphertext and wrapped keys only. Sealing and opening happen in the
  // envelope Secrets provider, so this object never sees a value or the key ring.
  credentialGet(scope: ScopeId, name: string): Outcome<StoredCredential | undefined> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const row = this.db.select().from(providerCredentials).where(eq(providerCredentials.name, name)).get();
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
    return this.db.transaction((tx) => {
      const current =
        tx
          .select({ version: providerCredentials.version })
          .from(providerCredentials)
          .where(eq(providerCredentials.name, name))
          .get()?.version ?? 0;
      if (version !== current + 1)
        return fail(
          new KarmiError("credential.conflict", `Credential "${name}" is at version ${current}; retry the put.`),
        );
      const values = { version, ...envelope, updatedAt: now, revokedAt: null };
      tx.insert(providerCredentials)
        .values({ name, createdAt: now, ...values })
        .onConflictDoUpdate({ target: providerCredentials.name, set: values })
        .run();
      return ok<CredentialInfo>({ source: "scope", version, updatedAt: now });
    });
  }

  /**
   * Drops the wrapped data key and ciphertext. The row stays so the version keeps counting and `describe`
   * reports it revoked.
   */
  credentialRevoke(scope: ScopeId, name: string): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    this.db
      .update(providerCredentials)
      .set({ kek: null, dek: null, ciphertext: null, revokedAt: this.deployment.clock.now() })
      .where(and(eq(providerCredentials.name, name), isNull(providerCredentials.revokedAt)))
      .run();
    return ok(undefined);
  }

  credentialList(scope: ScopeId): Outcome<StoredCredential[]> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    return ok(
      this.db.select().from(providerCredentials).orderBy(asc(providerCredentials.name)).all().map(decodeCredential),
    );
  }

  /**
   * Swaps the Envelope of one version in place. Returns false when a concurrent put or revoke changed the row.
   */
  credentialRewrap(scope: ScopeId, name: string, version: number, envelope: Envelope): Outcome<boolean> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const changed = this.db
      .update(providerCredentials)
      .set({ kek: envelope.kek, dek: envelope.dek, ciphertext: envelope.ciphertext })
      .where(
        and(
          eq(providerCredentials.name, name),
          eq(providerCredentials.version, version),
          isNull(providerCredentials.revokedAt),
          ne(providerCredentials.kek, envelope.kek),
        ),
      )
      .returning({ name: providerCredentials.name })
      .all();
    return ok(changed.length > 0);
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
        const rows = this.db
          .select({ partition: mcpCatalog.partition, catalog: mcpCatalog.catalog })
          .from(mcpCatalog)
          .where(eq(mcpCatalog.serverId, serverId))
          .orderBy(desc(mcpCatalog.updatedAt))
          .all();
        const own = rows.find((row) => row.partition === partition);
        if (own) return own.catalog;
        return rows.map((row) => row.catalog).find((catalog) => catalog.cacheScope === "public");
      }),
    );
  }

  mcpCatalogPut(scope: ScopeId, key: McpCatalogKey, catalog: McpCatalog): Outcome<void> {
    const head = this.enter(scope);
    if (!head.ok) return head;
    const updatedAt = this.deployment.clock.now();
    this.db
      .insert(mcpCatalog)
      .values({ ...key, catalog, updatedAt })
      .onConflictDoUpdate({ target: [mcpCatalog.serverId, mcpCatalog.partition], set: { catalog, updatedAt } })
      .run();
    return ok(undefined);
  }

  status(scope: ScopeId): Outcome<ScopeStatus> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
    if (!head.ok) return head;
    return ok({ state: head.value.state, configRevision: head.value.currentRevision });
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
    if (head.value.destroyOperationId !== null) return ok({ operationId: head.value.destroyOperationId });
    const operationId = crypto.randomUUID();
    const now = this.deployment.clock.now();
    this.db.transaction((tx) => {
      tx.update(scopeHead).set({ state: "destroying", destroyOperationId: operationId, updatedAt: now }).run();
      tx.insert(destroyOperations)
        .values({ operationId, state: "destroying", startedAt: now, updatedAt: now, cursor: startCursor() })
        .run();
      for (const table of TOMBSTONE_TABLES) tx.delete(table).run();
    });
    this.scheduleWalk(scope, operationId);
    return ok({ operationId });
  }

  // The walk runs on this object's alarm, one batch per firing, and re-arms itself until the Scope is empty.
  private scheduleWalk(scope: ScopeId, operationId: string): void {
    this.scheduler.set({
      id: DESTROY_ALARM,
      kind: "scope-maintenance",
      dueAt: this.deployment.clock.now(),
      payload: { scope, operationId },
    });
  }

  protected override async runAlarm(alarm: ScheduledAlarm): Promise<void> {
    if (alarm.kind !== "scope-maintenance") return super.runAlarm(alarm);
    const { scope, operationId } = decodeScopeMaintenanceAlarm(alarm.payload);
    const row = this.destroyOperation(operationId);
    // A late alarm for an operation that has already finished has nothing left to delete.
    if (!row || row.state === "destroyed") return;
    const cursor = await destroyStep(
      { scope, deployment: this.deployment, bindings: this.env, db: this.db, attempt: alarm.attempt },
      decodeCursor(row.cursor),
    );
    const done = cursor.progress.phase === "done";
    this.db
      .update(destroyOperations)
      .set({ cursor, state: done ? "destroyed" : "destroying", updatedAt: this.deployment.clock.now() })
      .where(eq(destroyOperations.operationId, operationId))
      .run();
    if (done) this.setState("destroyed");
    else this.scheduleWalk(scope, operationId);
  }

  /** The state of the destroy operation `operationId`. Throws `destroy.notFound` when there is none. */
  destroyStatus(scope: ScopeId, operationId: string): Outcome<DestroyStatus> {
    const head = this.enter(scope, /* refuseDestroyed */ false);
    if (!head.ok) return head;
    const row = this.destroyOperation(operationId);
    if (!row)
      return fail(new KarmiError("destroy.notFound", `No destroy operation "${operationId}" in Scope "${scope}".`));
    const { progress, external } = decodeCursor(row.cursor);
    return ok({ operationId, state: row.state, progress, ...(external && { externalCleanup: external }) });
  }

  private destroyOperation(operationId: string) {
    return this.db
      .select({ state: destroyOperations.state, cursor: destroyOperations.cursor })
      .from(destroyOperations)
      .where(eq(destroyOperations.operationId, operationId))
      .get();
  }
}

function decodeScopeMaintenanceAlarm(value: unknown): { scope: ScopeId; operationId: string } {
  if (
    !value ||
    typeof value !== "object" ||
    !("scope" in value) ||
    typeof value.scope !== "string" ||
    !("operationId" in value) ||
    typeof value.operationId !== "string"
  )
    throw new Error("Invalid Scope maintenance Alarm.");
  return { scope: value.scope, operationId: value.operationId };
}
