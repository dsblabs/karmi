import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import {
  catalogVersion,
  DEFAULT_CATALOG_TTL_MS,
  isStale,
  mcpHostAllowList,
  mcpPartition,
  type McpCatalog,
} from "./mcp-catalog";
import { describeMcpError, McpSession } from "./mcp-client";
import { remote, unwrap } from "./outcome";
import type { ScopeConfigDurableObject } from "./scope-config-do";
import type { McpServerConfig, ScopeConfigDocument } from "./scope-config";
import { scopedFetch } from "./scoped-fetch";
import type { SensitiveValue } from "./secrets";

// The MCP registry: what a Turn takes from the Scope for its servers (transport config, resolved static
// headers, the cached catalogue) and how a catalogue is refreshed. The ScopeConfig Durable Object only
// stores catalogues; credentials resolve here, in the caller's process, and never cross an RPC.

export interface McpSnapshotInput {
  /** Whose grants apply; unused while auth is `none` or `static`, required once OAuth lands. */
  agent?: string;
  user?: string;
  /** Which registered servers; every registered one when absent. */
  serverIds?: string[];
}

/** One server as a Turn sees it; `headers` are the resolved static credentials, held only in memory. */
export interface McpServerSnapshot {
  id: string;
  config: McpServerConfig;
  partition: string;
  headers?: Record<string, SensitiveValue>;
  /** The credential reference that did not resolve; the server is unusable until it does. */
  missing?: string;
  catalog?: McpCatalog;
}

export interface McpSnapshot {
  servers: McpServerSnapshot[];
  /** What the Turn's MCP `scopedFetch` may reach. */
  hosts: string[];
}

export class McpRegistry {
  constructor(
    private readonly deployment: Deployment,
    private readonly scopes: DurableObjectNamespace,
  ) {}

  private stub(scope: ScopeId) {
    return remote<ScopeConfigDurableObject>(this.scopes, keys.config(scope));
  }

  /** Builds the per-Turn egress for the registered servers: hosts narrowed by `egress.mcpHosts`. */
  egress(config: ScopeConfigDocument, servers: readonly { config: McpServerConfig }[]): typeof fetch {
    const hosts = mcpHostAllowList(
      servers.map((server) => server.config.url),
      config.egress?.mcpHosts,
    );
    return scopedFetch({ hosts, fetch: this.deployment.fetch });
  }

  /** No network: the registered servers, their credentials resolved, and whatever catalogue is cached. */
  async snapshot(scope: ScopeId, config: ScopeConfigDocument, input: McpSnapshotInput): Promise<McpSnapshot> {
    const registered = config.mcp?.servers ?? {};
    const ids = input.serverIds ?? Object.keys(registered);
    const servers: McpServerSnapshot[] = [];
    for (const id of ids) {
      const server = registered[id];
      if (!server) throw new KarmiError("mcp.server.unknown", `No MCP server "${id}" is registered in this Scope.`);
      servers.push({ id, config: server, partition: mcpPartition(), ...(await this.credentials(scope, server)) });
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
    return {
      servers,
      hosts: mcpHostAllowList(
        servers.map((server) => server.config.url),
        config.egress?.mcpHosts,
      ),
    };
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

  /** The cached catalogue while fresh; otherwise a refresh, falling back to the stale one when the server is unreachable. */
  async fresh(
    scope: ScopeId,
    server: McpServerSnapshot,
    egress: typeof fetch,
    signal?: AbortSignal,
  ): Promise<{ catalog: McpCatalog; refreshed: boolean } | { error: string }> {
    const { catalog } = server;
    if (catalog && !isStale(catalog, this.deployment.clock.now())) return { catalog, refreshed: false };
    try {
      return { catalog: await this.refresh(scope, server, egress, signal), refreshed: true };
    } catch (error) {
      if (!(error instanceof KarmiError)) throw error;
      return catalog ? { catalog, refreshed: false } : { error: error.message };
    }
  }

  /** One `tools/list` through a short-lived session; the result replaces the cached catalogue. */
  async refresh(
    scope: ScopeId,
    server: McpServerSnapshot,
    egress: typeof fetch,
    signal?: AbortSignal,
  ): Promise<McpCatalog> {
    if (server.missing !== undefined)
      throw new KarmiError(
        "mcp.discovery.failed",
        `Credential "${server.missing}" for MCP server "${server.id}" is missing.`,
      );
    let session: McpSession | undefined;
    try {
      session = await McpSession.open({ ...connection(server, egress), ...(signal && { signal }) });
      const { tools, hints } = await session.listTools(signal);
      const catalog: McpCatalog = {
        tools,
        catalogVersion: await catalogVersion(tools),
        fetchedAt: this.deployment.clock.now(),
        ttlMs: hints.ttlMs ?? server.config.catalog?.ttlMs ?? DEFAULT_CATALOG_TTL_MS,
        cacheScope: hints.cacheScope ?? "private",
        era: session.era(),
      };
      await unwrap(
        this.stub(scope).mcpCatalogPut(scope, { serverId: server.id, partition: server.partition }, catalog),
      );
      server.catalog = catalog;
      return catalog;
    } catch (caught) {
      if (caught instanceof KarmiError) throw caught;
      throw new KarmiError("mcp.discovery.failed", `MCP server "${server.id}": ${describeMcpError(caught)}`);
    } finally {
      await session?.close();
    }
  }
}

/** The transport inputs for one server: the plain headers, then the resolved static ones over them. */
export function connection(
  server: McpServerSnapshot,
  egress: typeof fetch,
): { url: string; headers: Record<string, string>; fetch: typeof fetch; prior?: McpCatalog["era"] } {
  const headers = { ...server.config.headers };
  for (const [header, value] of Object.entries(server.headers ?? {})) headers[header] = value.expose();
  return {
    url: server.config.url,
    headers,
    fetch: egress,
    ...(server.catalog && { prior: server.catalog.era }),
  };
}
