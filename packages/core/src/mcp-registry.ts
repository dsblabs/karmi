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
import { describeMcpError, McpSession, type McpConnection } from "./mcp-client";
import { fail, ok, remote, unwrap, type Outcome } from "./outcome";
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

/** The transport inputs for one server: the plain headers, then the resolved static ones over them. */
export function connection(server: McpServerSnapshot, egress: typeof fetch): Omit<McpConnection, "signal"> {
  const headers = { ...server.config.headers };
  for (const [header, value] of Object.entries(server.headers ?? {})) headers[header] = value.expose();
  return {
    url: server.config.url,
    headers,
    fetch: egress,
    ...(server.catalog && { prior: server.catalog.era }),
  };
}
