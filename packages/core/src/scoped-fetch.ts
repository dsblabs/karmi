import type { Logger } from "./context";
import type { ProviderConfig } from "./scope-config";

// The one egress seam: every outbound request karmi makes — provider calls, MCP, OAuth discovery — goes
// through a `scopedFetch` built per Turn from the resolved Scope config (docs/research/outbound-routing.md §5).
// It rejects private addresses and hosts outside its allow-list with a synthetic 403, forces manual
// redirects so a 3xx can never re-route around the check, and stamps nothing outbound.

/** Where every Cloudflare AI Gateway lives; the adapter builds its base URL on it. */
export const GATEWAY_HOST = "gateway.ai.cloudflare.com";

export interface EgressPolicy {
  /** Hostnames or `*.` globs; absent means any public host. */
  hosts?: string[];
  logger?: Logger;
  /** The transport underneath; the global `fetch` unless a test supplies one. */
  fetch?: typeof fetch;
}

export function scopedFetch(policy: EgressPolicy = {}): typeof fetch {
  const transport = policy.fetch ?? fetch;
  const hosts = policy.hosts?.map((host) => host.toLowerCase());
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (isBlockedUrl(url)) return denied(policy.logger, "egress.blocked", url);
    const host = new URL(url).hostname;
    if (hosts && !hosts.some((allowed) => matchesHost(host, allowed)))
      return denied(policy.logger, "egress.denied", host);
    return transport(input, { ...init, redirect: "manual" });
  }) as typeof fetch;
}

/** Which hosts a Provider profile may reach: its gateway, its `baseUrl`, or (absent both) any public host. */
export function providerHosts(profile: ProviderConfig): string[] | undefined {
  if (profile.gateway) return [GATEWAY_HOST];
  if (profile.baseUrl) return [new URL(profile.baseUrl).hostname];
  return undefined;
}

function matchesHost(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

function denied(logger: Logger | undefined, code: "egress.blocked" | "egress.denied", target: string): Response {
  const message =
    code === "egress.blocked"
      ? `Egress to ${target} is blocked: private, reserved or malformed address.`
      : `Egress to ${target} is outside this Scope's allowed hosts.`;
  logger?.warn("egress denied", { code, host: target });
  return Response.json({ error: { code, message } }, { status: 403 });
}

// SSRF guard vendored from cloudflare/agents (packages/agents/src/mcp/client/index.ts, MIT, © Cloudflare, Inc.).
// Loopback stays allowed on purpose: local development servers live there.
const BLOCKED_HOSTNAMES = new Set(["0.0.0.0", "[::]", "metadata.google.internal"]);
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]/;

/** True for malformed URLs and private, link-local, unspecified or cloud-metadata addresses. */
export function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const hostname = parsed.hostname;
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  const octets = hostname.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part)) && isPrivateIPv4(octets.map(Number)))
    return true;
  if (hostname.startsWith("[") && hostname.endsWith("]") && isPrivateIPv6(hostname.slice(1, -1).toLowerCase()))
    return true;
  return false;
}

function isPrivateIPv4([a, b = -1]: number[]): boolean {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return a === 0;
}

// Unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped forms in both dotted and hex spellings.
function isPrivateIPv6(address: string): boolean {
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (IPV6_LINK_LOCAL.test(address)) return true;
  if (!address.startsWith("::ffff:")) return false;
  const mapped = address.slice(7);
  const dotted = mapped.split(".");
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part))) return isPrivateIPv4(dotted.map(Number));
  const [hiHex, loHex, ...extra] = mapped.split(":");
  if (hiHex === undefined || loHex === undefined || extra.length > 0) return false;
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
}
