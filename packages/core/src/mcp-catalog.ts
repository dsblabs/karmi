import type { DiscoverResult, Tool as McpTool } from "@modelcontextprotocol/client";
import { sha256Hex } from "./digest";
import { IDENTIFIER } from "./names";
import { matchesHost } from "./scoped-fetch";
import { DEFAULT_ANNOTATIONS, type ToolAnnotations } from "./tool";

// The pure half of MCP consumption: what a Spec's `mcp:` reference means, how a server's tools become
// model-facing Tool names, which of them a server's allow/deny lists let through, and when a cached
// catalogue is stale. It does no network or storage I/O. The registry and the per-Turn source call into it.

export type { McpTool };

/** A parsed `mcp:` reference from an Agent Spec. */
export interface McpReference {
  server: string;
  /** One tool name. Absent means every allowed tool of the server. */
  tool?: string;
}

/** Parses `mcp:<server>` or `mcp:<server>/<tool>`. Anything else returns undefined. */
export function parseMcpReference(name: string): McpReference | undefined {
  if (!name.startsWith("mcp:")) return undefined;
  const [server = "", tool, ...rest] = name.slice("mcp:".length).split("/");
  if (rest.length > 0 || !IDENTIFIER.test(server) || (tool !== undefined && !IDENTIFIER.test(tool))) return undefined;
  return tool === undefined ? { server } : { server, tool };
}

/** The protocol Era a server answered with, adopted on the next connect without a probe. */
export type McpEra = { kind: "modern"; discover: DiscoverResult } | { kind: "legacy" };

/** One server's cached `tools/list` for one Partition, as the registry stores it. */
export interface McpCatalog {
  tools: McpTool[];
  /**
   * A digest of the ordered definitions. It changes only when the catalogue does, and so does the model's tool
   * prefix.
   */
  catalogVersion: string;
  /** When the list was fetched, as epoch milliseconds. */
  fetchedAt: number;
  /** How long the catalogue is served before Turn start refreshes it. */
  ttlMs: number;
  /** Whether another Partition may read this catalogue (`public`) or not (`private`). */
  cacheScope: "public" | "private";
  /** The protocol Era the server answered with. */
  era: McpEra;
}

/** The freshness hints a `tools/list` answer carries (SEP-2549). Both are absent on a legacy server. */
export interface CacheHints {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

/** A catalogue with no server hint is kept this long before Turn start refreshes it. */
export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;

/** Whether `catalog` has outlived its `ttlMs` at `now`. */
export function isStale(catalog: McpCatalog, now: number): boolean {
  return now >= catalog.fetchedAt + catalog.ttlMs;
}

/** The `catalogVersion` digest of `tools`: the first 16 hex characters of a SHA-256 over their JSON. */
export function catalogVersion(tools: readonly McpTool[]): Promise<string> {
  return sha256Hex(JSON.stringify(tools)).then((hex) => hex.slice(0, 16));
}

/** The longest model-facing tool name providers accept (`^[a-zA-Z0-9_-]{1,64}$`). */
const NAME_LIMIT = 64;

/** An MCP tool with the name the model sees it under. */
export interface NamedMcpTool {
  tool: McpTool;
  /**
   * The model-facing name, `server__tool` sanitised. The mapping back to `tool` is this pair and is never
   * re-derived.
   */
  name: string;
}

/**
 * Names every tool `${server}__${tool}` with anything outside `[a-zA-Z0-9_-]` replaced by `_`. A name that
 * overflows or collides is truncated with a hash suffix. The order is the server's own, so a stable
 * catalogue yields a stable list.
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

/**
 * The gating annotations for `tool`. A trusted server's own annotations are used. An untrusted server's
 * tools are treated as destructive.
 */
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

/** The `ttlMs` and `cacheScope` hints a list answer carried, decoded from its loose result body. */
export function cacheHints(result: Record<string, unknown>): CacheHints {
  const { ttlMs, cacheScope } = result;
  return {
    ...(typeof ttlMs === "number" && Number.isInteger(ttlMs) && ttlMs >= 0 && { ttlMs }),
    ...((cacheScope === "public" || cacheScope === "private") && { cacheScope }),
  };
}

// FNV-1a is used because the suffix only needs to be cheap, synchronous and stable.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
