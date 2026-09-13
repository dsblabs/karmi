import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { mcpHolder, mcpPartition, resolveHolder, type McpHolder, type McpHolderRef } from "./mcp-auth";
import { catalogVersion, DEFAULT_CATALOG_TTL_MS, isStale, mcpHostAllowList, type McpCatalog } from "./mcp-catalog";
import { describeMcpError, McpSession, type McpConnection } from "./mcp-client";
import { fail, ok, remote, unwrap, type Outcome } from "./outcome";
import type { McpAuthorizeInput, McpGrantView, ScopeConfigDurableObject } from "./scope-config-do";
import type { McpServerConfig, ScopeConfigDocument } from "./scope-config";
import { scopedFetch } from "./scoped-fetch";
import { sensitive, type SensitiveValue } from "./secrets";

// The MCP registry: what a Turn takes from the Scope for its servers (transport config, resolved static
// headers, the holder's access token, the cached catalogue) and how a catalogue is refreshed. The
// ScopeConfig Durable Object stores catalogues and grants; static credentials resolve here, in the
// caller's process, and refresh tokens never leave the Durable Object.

export interface McpSnapshotInput {
  /** Whose grants apply: the Agent for agent-level OAuth servers, the User for user-level ones. */
  agent?: string;
  user?: string;
  /** Which registered servers; every registered one when absent. */
  serverIds?: string[];
}

/** An OAuth server as one Turn sees it: whose grant, and the access token when the holder has one. */
export interface McpOAuthState {
  level: "agent" | "user";
  /** Absent on a user-less Thread for a user-level server: no Connection can ever resolve. */
  holder?: McpHolder;
  /** The access token in memory for this Turn; absent until the holder consents. */
  token?: SensitiveValue;
  /** What the token was granted for, the base of a step-up union. */
  scope?: string;
}

/** One server as a Turn sees it; `headers` are the resolved static credentials, held only in memory. */
export interface McpServerSnapshot {
  id: string;
  config: McpServerConfig;
  partition: string;
  headers?: Record<string, SensitiveValue>;
  /** The credential reference that did not resolve; the server is unusable until it does. */
  missing?: string;
  oauth?: McpOAuthState;
  /** The cached catalogue, replaced in place by a refresh. */
  catalog?: McpCatalog;
}

export interface McpSnapshot {
  servers: McpServerSnapshot[];
}

export class McpRegistry {
  constructor(
    private readonly deployment: Deployment,
    private readonly scopes: DurableObjectNamespace,
  ) {}

  private stub(scope: ScopeId) {
    return remote<ScopeConfigDurableObject>(this.scopes, keys.config(scope));
  }

  /** The egress for a Turn's servers: their hosts, narrowed by `egress.mcpHosts`. */
  egress(config: ScopeConfigDocument, servers: readonly McpServerSnapshot[]): typeof fetch {
    const hosts = mcpHostAllowList(
      servers.map((server) => server.config.url),
      config.egress?.mcpHosts,
    );
    return scopedFetch({ hosts, fetch: this.deployment.fetch });
  }

  /** No network to the servers: the registered ones, their credentials resolved, and whatever catalogue is cached. */
  async snapshot(scope: ScopeId, config: ScopeConfigDocument, input: McpSnapshotInput): Promise<McpSnapshot> {
    const registered = config.mcp?.servers ?? {};
    const ids = input.serverIds ?? Object.keys(registered);
    const servers: McpServerSnapshot[] = [];
    for (const id of ids) {
      const server = registered[id];
      if (!server) throw new KarmiError("mcp.server.unknown", `No MCP server "${id}" is registered in this Scope.`);
      const oauth = await this.grant(scope, id, server, input);
      servers.push({
        id,
        config: server,
        partition: mcpPartition(server.auth, oauth?.holder),
        ...(await this.credentials(scope, server)),
        ...(oauth && { oauth }),
      });
    }
    const catalogs = await unwrap(
      this.stub(scope).mcpCatalogGet(
        scope,
        servers.map(({ id, partition }) => ({ serverId: id, partition })),
      ),
    );
    catalogs.forEach((catalog, i) => {
      const server = servers[i];
      if (server && catalog) server.catalog = catalog;
    });
    return { servers };
  }

  private async credentials(
    scope: ScopeId,
    server: McpServerConfig,
  ): Promise<Pick<McpServerSnapshot, "headers" | "missing">> {
    if (server.auth?.type !== "static") return {};
    const headers: Record<string, SensitiveValue> = {};
    for (const [header, ref] of Object.entries(server.auth.headers)) {
      const resolved = await this.deployment.secrets.resolve({ scope, ref });
      if (!resolved) return { missing: ref };
      headers[header] = resolved.value;
    }
    return { headers };
  }

  private async grant(
    scope: ScopeId,
    id: string,
    server: McpServerConfig,
    input: McpSnapshotInput,
  ): Promise<McpOAuthState | undefined> {
    if (server.auth?.type !== "oauth") return undefined;
    const { level } = server.auth;
    const holder = mcpHolder(level, input.agent, input.user);
    if (holder === undefined) return { level };
    const view = await unwrap(this.stub(scope).mcpRefresh(scope, id, holder));
    return { level, holder, ...grantState(view) };
  }

  /**
   * A token the server refused: one refresh through the Durable Object, which hands back the current
   * token when another Turn already rotated it. The snapshot is updated in place; `false` means the
   * holder must consent again.
   */
  async refreshToken(scope: ScopeId, server: McpServerSnapshot): Promise<boolean> {
    const { oauth } = server;
    if (!oauth?.holder) return false;
    const view = await unwrap(this.stub(scope).mcpRefresh(scope, server.id, oauth.holder, oauth.token?.expose()));
    const next = grantState(view);
    delete oauth.token;
    delete oauth.scope;
    Object.assign(oauth, next);
    return next.token !== undefined;
  }

  /** Starts a consent flow for one server; the answer is where the human must go. */
  async authorize(scope: ScopeId, input: McpAuthorizeInput): Promise<{ authUrl: string }> {
    return unwrap(this.stub(scope).mcpAuthorize(scope, input));
  }

  /** Drops the grant and the private catalogue partition of one holder. */
  async disconnect(scope: ScopeId, config: ScopeConfigDocument, input: McpHolderRef): Promise<void> {
    const server = config.mcp?.servers?.[input.serverId];
    if (!server)
      throw new KarmiError("mcp.server.unknown", `No MCP server "${input.serverId}" is registered in this Scope.`);
    const holder = resolveHolder(server.auth, input);
    if (!holder.ok) throw holder.error;
    await unwrap(this.stub(scope).mcpDisconnect(scope, input.serverId, holder.holder));
  }

  /**
   * The catalogue a Turn runs under: the cached one while fresh, else a refresh through `session`,
   * falling back to the stale one when the server cannot be listed. Fails only with nothing to serve.
   */
  async currentCatalog(
    scope: ScopeId,
    server: McpServerSnapshot,
    session: () => Promise<McpSession>,
    signal?: AbortSignal,
  ): Promise<Outcome<McpCatalog>> {
    const { catalog } = server;
    if (catalog && !isStale(catalog, this.deployment.clock.now())) return ok(catalog);
    const listed = await this.list(scope, server, session, signal);
    return listed.ok || !catalog ? listed : ok(catalog);
  }

  /** One `tools/list` through `session`; the result replaces the cached catalogue, on the server and in the store. */
  async list(
    scope: ScopeId,
    server: McpServerSnapshot,
    session: () => Promise<McpSession>,
    signal?: AbortSignal,
  ): Promise<Outcome<McpCatalog>> {
    if (server.missing !== undefined)
      return fail(
        new KarmiError(
          "mcp.discovery.failed",
          `Credential "${server.missing}" for MCP server "${server.id}" is missing.`,
        ),
      );
    try {
      const open = await session();
      const { tools, hints } = await open.listTools(signal);
      const catalog: McpCatalog = {
        tools,
        catalogVersion: await catalogVersion(tools),
        fetchedAt: this.deployment.clock.now(),
        ttlMs: hints.ttlMs ?? server.config.catalog?.ttlMs ?? DEFAULT_CATALOG_TTL_MS,
        cacheScope: hints.cacheScope ?? "private",
        era: open.era(),
      };
      await unwrap(
        this.stub(scope).mcpCatalogPut(scope, { serverId: server.id, partition: server.partition }, catalog),
      );
      server.catalog = catalog;
      return ok(catalog);
    } catch (caught) {
      if (caught instanceof KarmiError) return fail(caught);
      return fail(new KarmiError("mcp.discovery.failed", `MCP server "${server.id}": ${describeMcpError(caught)}`));
    }
  }

  /** A refresh on request, outside any Turn: one short-lived session, dropped when the list is stored. */
  async refresh(
    scope: ScopeId,
    server: McpServerSnapshot,
    egress: typeof fetch,
    signal: AbortSignal,
  ): Promise<McpCatalog> {
    let opened: McpSession | undefined;
    const session = async () => (opened = await McpSession.open({ ...connection(server, egress), signal }));
    try {
      return await unwrap(this.list(scope, server, session, signal));
    } finally {
      await opened?.close();
    }
  }
}

function grantState(view: McpGrantView | undefined): Pick<McpOAuthState, "token" | "scope"> {
  if (!view) return {};
  return { token: sensitive(view.token), ...(view.scope !== undefined && { scope: view.scope }) };
}

/**
 * The transport inputs for one server: the plain headers, the resolved static ones over them, and the
 * bearer read from the snapshot on every request, so a refreshed token reaches an open session.
 */
export function connection(server: McpServerSnapshot, egress: typeof fetch): Omit<McpConnection, "signal"> {
  const headers = { ...server.config.headers };
  for (const [header, value] of Object.entries(server.headers ?? {})) headers[header] = value.expose();
  return {
    url: server.config.url,
    headers,
    fetch: egress,
    ...(server.oauth && { bearer: () => server.oauth?.token?.expose() }),
    ...(server.catalog && { prior: server.catalog.era }),
  };
}
