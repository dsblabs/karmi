import type { OAuthDiscoveryState, StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { NormalizedAgentSpec } from "../../agent-spec";
import type { McpCatalog } from "../../mcp-catalog";
import type { ScopeConfigDocument } from "../../scope-config";
import type { DestroyCursor } from "../../scope-destroy";
import type { DestroyStatus, ScopeState } from "../../scope-config-do";
import type { ThreadIdentity } from "../../thread";

/** This table stores the identity, lifecycle state and current config revision of the Scope. */
export const scopeHead = sqliteTable("scope_head", {
  scopeId: text("scope_id").primaryKey(),
  state: text().$type<ScopeState>().notNull(),
  currentRevision: integer("current_revision").notNull(),
  destroyOperationId: text("destroy_operation_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
/** This table stores every validated Scope config document by revision. */
export const scopeRevisions = sqliteTable("scope_revisions", {
  revision: integer().primaryKey(),
  config: text("config_json", { mode: "json" }).$type<ScopeConfigDocument>().notNull(),
  createdAt: integer("created_at").notNull(),
});
/** This table stores the recent validated versions of each Agent Spec. */
export const agentSpecs = sqliteTable(
  "agent_specs",
  {
    agentId: text("agent_id").notNull(),
    version: integer().notNull(),
    spec: text("spec_json", { mode: "json" }).$type<NormalizedAgentSpec>().notNull(),
    catalogueFingerprint: text("catalogue_fingerprint").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.version] })],
);
/** This table points each Agent at its current version and records a soft delete. */
export const agentHeads = sqliteTable("agent_heads", {
  agentId: text("agent_id").primaryKey(),
  currentVersion: integer("current_version").notNull(),
  deletedAt: integer("deleted_at"),
});
/** This table records each destroy operation and where its maintenance walk has got to. */
export const destroyOperations = sqliteTable("destroy_operations", {
  operationId: text("operation_id").primaryKey(),
  state: text().$type<DestroyStatus["state"]>().notNull(),
  startedAt: integer("started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  cursor: text("cursor_json", { mode: "json" }).$type<DestroyCursor>(),
});
/** This table indexes the Scope's Threads so they can be listed and destroyed. */
export const threads = sqliteTable(
  "threads",
  {
    threadId: text("thread_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    userId: text("user_id"),
    createdAt: integer("created_at").notNull(),
    lastActiveAt: integer("last_active_at").notNull(),
    title: text(),
  },
  (table) => [index("threads_by_agent_user").on(table.agentId, table.userId, table.lastActiveAt)],
);
/** This table links a Delegation child Thread to the parent Thread and call that started it. */
export const threadParents = sqliteTable(
  "thread_parents",
  {
    threadId: text("thread_id").primaryKey(),
    threadKey: text("thread_key").notNull(),
    callId: text("call_id").notNull(),
  },
  (table) => [index("thread_parents_by_parent").on(table.threadKey)],
);
/** This table stores the Agent-level Connection values. */
export const connections = sqliteTable(
  "connections",
  {
    agentId: text("agent_id").notNull(),
    name: text().notNull(),
    value: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);
/** This table stores the User-level Connection values. */
export const userConnections = sqliteTable(
  "user_connections",
  {
    userId: text("user_id").notNull(),
    name: text().notNull(),
    value: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })],
);
/** This table stores the sealed Envelopes of the Scope's own credentials. */
export const providerCredentials = sqliteTable("provider_credentials", {
  name: text().primaryKey(),
  version: integer().notNull(),
  kek: text(),
  dek: text(),
  ciphertext: text(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  revokedAt: integer("revoked_at"),
});
/** This table caches one MCP `tools/list` result per server and credential Partition. */
export const mcpCatalog = sqliteTable(
  "mcp_catalog",
  {
    serverId: text("server_id").notNull(),
    partition: text().notNull(),
    catalog: text("catalog_json", { mode: "json" }).$type<McpCatalog>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.partition] })],
);
/** This table indexes the Scope's Knowledge corpora so they can be listed and destroyed. */
export const knowledgeNames = sqliteTable("knowledge_names", {
  name: text().primaryKey(),
});
/** This table indexes the Users with a Memory so their Memory can be listed and destroyed. */
export const memoryUsers = sqliteTable("memory_users", {
  userId: text("user_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});
/** This table holds one Workspace slot for each Thread that reserved a container. */
export const containerLeases = sqliteTable("container_leases", {
  threadId: text("thread_id").primaryKey(),
});
/** This table stores the OAuth client registered with each authorization server; secrets live elsewhere. */
export const mcpClients = sqliteTable("mcp_clients", {
  issuer: text().primaryKey(),
  clientId: text("client_id").notNull(),
  secretRef: text("secret_ref"),
  info: text("info_json", { mode: "json" }).$type<Omit<StoredOAuthClientInformation, "client_secret">>().notNull(),
  createdAt: integer("created_at").notNull(),
});
/** This table stores one MCP OAuth grant, with its refresh token, per server and Holder. */
export const mcpGrants = sqliteTable(
  "mcp_grants",
  {
    serverId: text("server_id").notNull(),
    holder: text().notNull(),
    issuer: text().notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: integer("expires_at"),
    scope: text(),
    discovery: text("discovery_json", { mode: "json" }).$type<OAuthDiscoveryState>(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.holder] })],
);
/** This table stores the MCP OAuth authorizations pending between redirect and callback. */
export const mcpOAuthState = sqliteTable("mcp_oauth_state", {
  nonce: text().primaryKey(),
  serverId: text("server_id").notNull(),
  holder: text().notNull(),
  userId: text("user_id"),
  thread: text("thread_json", { mode: "json" }).$type<ThreadIdentity>(),
  returnTo: text("return_to"),
  verifier: text(),
  discovery: text("discovery_json", { mode: "json" }).$type<OAuthDiscoveryState>(),
  expiresAt: integer("expires_at").notNull(),
});

/** The complete relational schema of the Scope config Durable Object. */
export const scopeConfigSchema = {
  scopeHead,
  scopeRevisions,
  agentSpecs,
  agentHeads,
  destroyOperations,
  threads,
  threadParents,
  connections,
  userConnections,
  providerCredentials,
  mcpCatalog,
  knowledgeNames,
  memoryUsers,
  containerLeases,
  mcpClients,
  mcpGrants,
  mcpOAuthState,
};

/** The typed database of the Scope config Durable Object, shared by its internal storage helpers. */
export type ScopeConfigDatabase = DrizzleSqliteDODatabase<typeof scopeConfigSchema>;
