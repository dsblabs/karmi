import type { DiscoverResult, Tool as McpTool } from "@modelcontextprotocol/client";
import { sha256Hex } from "./digest";
import { IDENTIFIER } from "./names";
import { matchesHost } from "./scoped-fetch";
import { DEFAULT_ANNOTATIONS, type ToolAnnotations } from "./tool";

// The pure half of MCP consumption: what a Spec's `mcp:` reference means, how a server's tools become
// model-facing Tool names, which of them a server's allow/deny lists let through, and when a cached
// catalogue is stale. No network, no storage: the registry and the per-Turn source call in here.

export type { McpTool };

export interface McpReference {
  server: string;
  tool?: string;
}

/** `mcp:<server>` or `mcp:<server>/<tool>`; anything else is not a reference. */
export function parseMcpReference(name: string): McpReference | undefined {
  if (!name.startsWith("mcp:")) return undefined;
  const [server = "", tool, ...rest] = name.slice("mcp:".length).split("/");
  if (rest.length > 0 || !IDENTIFIER.test(server) || (tool !== undefined && !IDENTIFIER.test(tool))) return undefined;
  return tool === undefined ? { server } : { server, tool };
}

/** The era verdict a server gave last time, adopted on the next connect with zero round trips. */
export type McpEra = { kind: "modern"; discover: DiscoverResult } | { kind: "legacy" };

/** One server's cached `tools/list` for one credential partition, as the registry stores it. */
export interface McpCatalog {
  tools: McpTool[];
  /** Digest of the ordered definitions; stable while the catalogue is, so the model's tool prefix is too. */
  catalogVersion: string;
  fetchedAt: number;
  ttlMs: number;
  cacheScope: "public" | "private";
  era: McpEra;
}

/** What a `tools/list` answer says about its own freshness (SEP-2549); absent on a legacy server. */
export interface CacheHints {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

/** A catalogue with no server hint is kept this long before Turn start refreshes it. */
export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;

export function isStale(catalog: McpCatalog, now: number): boolean {
  return now >= catalog.fetchedAt + catalog.ttlMs;
}

export function catalogVersion(tools: readonly McpTool[]): Promise<string> {
  return sha256Hex(JSON.stringify(tools)).then((hex) => hex.slice(0, 16));
}

/** Providers accept `^[a-zA-Z0-9_-]{1,64}$`; every model-facing name is cut to fit. */
const NAME_LIMIT = 64;

export interface NamedMcpTool {
  tool: McpTool;
  /** The model-facing name, `server__tool` sanitised; the mapping back is kept here, never re-derived. */
  name: string;
}

/**
 * `${server}__${tool}` with anything outside `[a-zA-Z0-9_-]` replaced, truncated with a hash suffix on
 * overflow or collision, in the server's own order so a stable catalogue yields a stable list.
 */
export function nameTools(serverId: string, tools: readonly McpTool[]): NamedMcpTool[] {
  const taken = new Set<string>();
  return tools.map((tool) => {
    const base = `${serverId}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    let name = base;
    if (name.length > NAME_LIMIT || taken.has(name)) {
      const suffix = `_${fnv1a(tool.name)}`;
      name = `${base.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
    }
    taken.add(name);
    return { tool, name };
  });
}

/** The tools a reference selects from a catalogue, after the server's allow and deny lists. */
export function selectTools(
  tools: readonly NamedMcpTool[],
  lists: { allow?: string[]; deny?: string[] },
  ref: McpReference,
): NamedMcpTool[] {
  return tools.filter(({ tool }) => {
    if (ref.tool !== undefined && tool.name !== ref.tool) return false;
    if (lists.allow && !lists.allow.includes(tool.name)) return false;
    return !lists.deny?.includes(tool.name);
  });
}

/** A trusted server's annotations drive gating; an untrusted server's tools are treated as destructive. */
export function mcpAnnotations(tool: McpTool, trusted: boolean): ToolAnnotations {
  if (!trusted || !tool.annotations) return DEFAULT_ANNOTATIONS;
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = tool.annotations;
  return {
    readOnlyHint: readOnlyHint ?? DEFAULT_ANNOTATIONS.readOnlyHint,
    destructiveHint: destructiveHint ?? DEFAULT_ANNOTATIONS.destructiveHint,
    idempotentHint: idempotentHint ?? DEFAULT_ANNOTATIONS.idempotentHint,
    openWorldHint: openWorldHint ?? DEFAULT_ANNOTATIONS.openWorldHint,
  };
}

/** The hosts a Turn's MCP `scopedFetch` allows: the registered servers, narrowed by `egress.mcpHosts`. */
export function mcpHostAllowList(urls: readonly string[], mcpHosts: readonly string[] | undefined): string[] {
  const hosts = urls.map((url) => new URL(url).hostname.toLowerCase());
  return mcpHosts ? hosts.filter((host) => mcpHosts.some((pattern) => matchesHost(host, pattern))) : hosts;
}

/** The `ttlMs`/`cacheScope` a list answer carried, read once off its loose result body. */
export function cacheHints(result: Record<string, unknown>): CacheHints {
  const { ttlMs, cacheScope } = result;
  return {
    ...(typeof ttlMs === "number" && Number.isInteger(ttlMs) && ttlMs >= 0 && { ttlMs }),
    ...((cacheScope === "public" || cacheScope === "private") && { cacheScope }),
  };
}

// FNV-1a over the original name: cheap, synchronous and stable, which is all a suffix needs.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
