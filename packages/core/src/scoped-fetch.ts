import type { Logger } from "./context";
import type { ProviderConfig } from "./scope-config";

// Every outbound request karmi makes (provider calls, MCP, OAuth discovery) goes through a `scopedFetch`
// built per Turn from the resolved Scope config (docs/research/outbound-routing.md §5). It answers a private
// address or a host outside its allow-list with a synthetic 403 and forces manual redirects so a 3xx cannot
// re-route around the check. It adds nothing to the outbound request.

/** The host every Cloudflare AI Gateway is served from. The adapter builds its base URL on it. */
export const GATEWAY_HOST = "gateway.ai.cloudflare.com";

/** The rules a `scopedFetch` enforces on every outbound request. */
export interface EgressPolicy {
  /** The hostnames or `*.domain` globs a request may reach. Absent means any public host. */
  hosts?: string[];
  /** Receives a warning for every denied request. */
  logger?: Logger;
  /** The transport that carries allowed requests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A `fetch` that enforces `policy`. It answers a blocked or disallowed URL with a 403 and never follows
 * redirects.
 */
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

/**
 * The hosts a Provider profile may reach. A gateway profile reaches only the gateway host and a `baseUrl`
 * profile only that host. A profile with neither may reach any public host, returned as undefined.
 */
export function providerHosts(profile: ProviderConfig): string[] | undefined {
  if (profile.gateway) return [GATEWAY_HOST];
  if (profile.baseUrl) return [new URL(profile.baseUrl).hostname];
  return undefined;
}

/** Whether `host` equals `pattern` or falls under a `*.domain` glob `pattern`. */
export function matchesHost(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

type DenialCode = "egress.blocked" | "egress.denied";

function denied(logger: Logger | undefined, code: DenialCode, target: string): Response {
  const message =
    code === "egress.blocked"
      ? `Egress to ${target} is blocked: private, reserved or malformed address.`
      : `Egress to ${target} is outside this Scope's allowed hosts.`;
  logger?.warn("egress denied", { code, host: target });
  return Response.json({ error: { code, message } }, { status: 403 });
}

/** The message from a synthetic egress-denial 403 body, or undefined when `text` is not one. */
export function decodeEgressDenial(text: string): string | undefined {
  if (!text.includes('"egress.')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return undefined;
  const { error } = parsed;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string")
    return undefined;
  return error.message;
}

// The SSRF guard is vendored from cloudflare/agents
// (packages/agents/src/mcp/client/index.ts, MIT, © Cloudflare, Inc.).
// Loopback is allowed so local development servers stay reachable.
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

// Matches unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped addresses in dotted or hex form.
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
