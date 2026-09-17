import { HOST_PATTERN } from "./names";
import { DEFAULT_MEDIA_BYTES, matchesType } from "./media";
import * as z from "zod/mini";
import {
  CapabilityLimitSchemas,
  name,
  PolicyRuleSchema,
  positiveInt,
  ProviderToolNameSchema,
  ScriptTierSchema,
} from "./agent-spec";
import type { PolicyRule, ProviderToolName } from "./agent";
import { KarmiError } from "./errors";
import { IDENTIFIER } from "./names";
import { toJsonSchema, type JsonSchema } from "./schema";
import { isBlockedUrl, matchesHost } from "./scoped-fetch";
import { CREDENTIAL_REF, FALLBACK_REASONS, type FallbackReason } from "./secrets";
import { firstIssue, pointer } from "./validate";

// This module defines the secret-free Scope config document. `scope.config.set` stores it as one immutable
// revision, and `createKarmi({ defaults })` supplies the same shape as the Deployment layer every Scope
// inherits and may only tighten.

// A credential is always a reference into a secret store. Refusing a pasted value is the reason this
// pattern exists.
const SECRET_LOOKING_KEY = /key|secret|token|password|authorization/i;

const credentialRef = z
  .string()
  .check(z.regex(CREDENTIAL_REF, "must be scope:<name> or deployment:<name>, never a value"));

// Cloudflare AI Gateway is configuration under any adapter: a URL plus `cf-aig-*` headers. The numeric
// bounds are the gateway's own.
const GatewaySchema = z.strictObject({
  kind: z.literal("cloudflare"),
  accountId: name,
  gatewayId: name,
  /** The credential reference of the `cf-aig-authorization` token. Absent for an unauthenticated gateway. */
  credential: z.optional(credentialRef),
  /** Whether the provider key is stored in the gateway, in which case the profile carries none. */
  byok: z.optional(z.boolean()),
  /**
   * Extra `cf-aig-metadata` entries beside karmi's own four (scope, agent, thread, turn). At most five are
   * sent.
   */
  metadata: z.optional(
    z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .check(z.refine((metadata) => Object.keys(metadata).length <= 5, "at most 5 entries")),
  ),
  cache: z.optional(
    z.strictObject({ ttl: z.optional(positiveInt), skip: z.optional(z.boolean()), key: z.optional(z.string()) }),
  ),
  retry: z.optional(
    z.strictObject({
      maxAttempts: z.optional(z.int().check(z.minimum(1), z.maximum(5))),
      delayMs: z.optional(z.int().check(z.minimum(0), z.maximum(5000))),
      backoff: z.optional(z.enum(["constant", "linear", "exponential"])),
    }),
  ),
  timeoutMs: z.optional(positiveInt),
});

const ProviderConfigSchema = z.strictObject({
  /** The name of a Provider registered in `createKarmi({ providers })`. */
  adapter: name,
  /** The model-id globs this profile can serve. Defaults to `<adapter>/*`. */
  models: z.optional(z.array(z.string().check(z.minLength(1)))),
  credential: z.optional(credentialRef),
  /** The endpoint of a self-hosted or OpenAI-compatible provider. Ignored when a gateway is set. */
  baseUrl: z.optional(z.url()),
  gateway: z.optional(GatewaySchema),
  /** Who summarises at Compaction: the Harness (the default) or the provider's own mechanism. */
  compaction: z.optional(z.enum(["harness", "provider"])),
  /** How media reaches the provider. `inline` sends base64 at request build. */
  media: z.optional(z.strictObject({ strategy: z.literal("inline") })),
  /** Adapter-namespaced options forwarded verbatim, such as `{ anthropic: { effort: "high" } }`. */
  providerOptions: z.optional(z.record(z.string(), z.unknown())),
  headers: z.optional(z.record(z.string(), z.string())),
  /**
   * The Credential fallback: the Deployment profile to run under when this profile's credential is
   * missing or fails as listed.
   */
  fallback: z.optional(
    z.strictObject({
      profile: name,
      /** Defaults to `["missing"]`. */
      on: z.optional(z.array(z.enum(FALLBACK_REASONS)).check(z.minLength(1))),
    }),
  ),
});

// `false` switches a Capability off for the Scope. An absent block leaves it unbounded.
const ceiling = <T extends z.core.$ZodType>(schema: T) => z.optional(z.union([z.literal(false), schema]));
const CeilingsSchema = z.strictObject({
  scripts: ceiling(
    z.strictObject({
      tier: z.optional(ScriptTierSchema),
      maxContainers: z.optional(positiveInt),
      limits: z.optional(CapabilityLimitSchemas.scripts),
    }),
  ),
  longRunning: ceiling(CapabilityLimitSchemas.longRunning),
  delegation: ceiling(CapabilityLimitSchemas.delegation),
  scheduling: ceiling(z.extend(CapabilityLimitSchemas.scheduling, { cron: z.optional(z.boolean()) })),
  providerTools: ceiling(
    z.strictObject({
      tools: z.optional(z.array(ProviderToolNameSchema)),
      limits: z.optional(CapabilityLimitSchemas.providerTools),
    }),
  ),
  approvals: z.optional(z.strictObject({ timeout: z.optional(positiveInt) })),
  /** The largest context window an Agent here may assume. A Spec's `context.window` is capped to it. */
  context: z.optional(z.strictObject({ window: z.optional(positiveInt) })),
});

const hostPattern = z.string().check(z.regex(HOST_PATTERN, "must be a hostname or a *.domain glob"));
const toolName = z.string().check(z.minLength(1));

// A remote MCP server this Scope's Agents may reference as `mcp:<id>`. Static auth headers are credential
// references, so the values sit encrypted in the credential store and never in a revision.
const McpServerSchema = z.strictObject({
  url: z.url(),
  auth: z.optional(
    z.union([
      z.strictObject({ type: z.literal("none") }),
      z.strictObject({
        type: z.literal("static"),
        headers: z.record(z.string().check(z.minLength(1)), credentialRef),
      }),
      // An OAuth grant is the Connection `mcp:<id>`, held per Agent or per User. Tokens live in ScopeConfig.
      z.strictObject({
        type: z.literal("oauth"),
        level: z.enum(["agent", "user"]),
        /** The OAuth scopes to request. Absent lets the server's metadata decide. */
        scope: z.optional(z.string().check(z.minLength(1))),
        /** A pre-registered client for this server's issuer. The secret, if any, is a credential reference. */
        client: z.optional(z.strictObject({ id: z.string().check(z.minLength(1)), secret: z.optional(credentialRef) })),
      }),
    ]),
  ),
  /** Who calls the server's tools: the Harness (the default) or the model provider's own MCP connector. */
  execution: z.optional(z.enum(["harness", "provider"])),
  /** Non-secret headers sent on every request. A header that authenticates belongs under `auth`. */
  headers: z.optional(z.record(z.string(), z.string())),
  /** The server's own tool names an Agent may see. Absent means every tool. */
  allow: z.optional(z.array(toolName)),
  deny: z.optional(z.array(toolName)),
  /** Whether the server's annotations drive Approval gating. Otherwise its tools count as destructive. */
  trustAnnotations: z.optional(z.boolean()),
  catalog: z.optional(z.strictObject({ ttlMs: z.optional(positiveInt) })),
});

/** The schema of a Scope config document. */
export const ScopeConfigSchema = z.strictObject({
  mcp: z.optional(
    z.strictObject({
      servers: z.optional(
        z.record(z.string().check(z.regex(IDENTIFIER, "must match [A-Za-z0-9_-]{1,64}")), McpServerSchema),
      ),
    }),
  ),
  egress: z.optional(z.strictObject({ mcpHosts: z.optional(z.array(hostPattern)) })),
  media: z.optional(
    z.strictObject({
      maxBytes: z.optional(positiveInt),
      allowedTypes: z.optional(z.array(z.string().check(z.minLength(1)))),
    }),
  ),
  providers: z.optional(z.record(name, ProviderConfigSchema)),
  ceilings: z.optional(CeilingsSchema),
  policy: z.optional(z.array(PolicyRuleSchema)),
});

/** A Cloudflare AI Gateway in front of a Provider profile. */
export interface GatewayConfig {
  kind: "cloudflare";
  accountId: string;
  gatewayId: string;
  /** The credential reference of the `cf-aig-authorization` token. Absent for an unauthenticated gateway. */
  credential?: string;
  /** Whether the provider key is stored in the gateway, in which case the profile carries none. */
  byok?: boolean;
  /** Extra `cf-aig-metadata` entries beside karmi's own four (scope, agent, thread, turn). */
  metadata?: Record<string, string | number | boolean>;
  /** The gateway's response cache settings. */
  cache?: { ttl?: number; skip?: boolean; key?: string };
  /** The gateway's own retry settings. */
  retry?: { maxAttempts?: number; delayMs?: number; backoff?: "constant" | "linear" | "exponential" };
  timeoutMs?: number;
}

/**
 * One Provider profile: an adapter, what it may serve, and how the adapter reaches the provider. It holds
 * no secrets.
 */
export interface ProviderConfig {
  /** The name of a Provider registered in `createKarmi({ providers })`. */
  adapter: string;
  /** The model-id globs this profile can serve. Defaults to `<adapter>/*`. */
  models?: string[];
  /** The credential reference, `scope:<name>` or `deployment:<name>`. */
  credential?: string;
  /** The endpoint of a self-hosted or OpenAI-compatible provider. Ignored when a gateway is set. */
  baseUrl?: string;
  gateway?: GatewayConfig;
  /** Who summarises at Compaction: the Harness (the default) or the provider's own mechanism. */
  compaction?: "harness" | "provider";
  /** How media reaches the provider. `inline` sends base64 at request build. */
  media?: { strategy: "inline" };
  /** Adapter-namespaced options forwarded verbatim. */
  providerOptions?: Record<string, unknown>;
  /** Non-secret headers sent on every request. */
  headers?: Record<string, string>;
  /** The Credential fallback to a Deployment profile. */
  fallback?: ProfileFallback;
}

/** A Provider profile's Credential fallback: which Deployment profile to run under, and when. */
export interface ProfileFallback {
  /** The Deployment profile to fall back to. */
  profile: string;
  /** The reasons that engage the fallback. Defaults to `["missing"]`. */
  on?: FallbackReason[];
}

/** Upper bounds on what an Agent Spec in this Scope may ask for. `false` makes the Capability unavailable. */
export interface Ceilings {
  scripts?:
    | false
    | {
        tier?: "isolate" | "container";
        /** The maximum number of live Workspaces in this Scope. */
        maxContainers?: number;
        limits?: {
          cpuMs?: number;
          wallMs?: number;
          maxToolCalls?: number;
          idleMs?: number;
          jobMaxWallMs?: number;
          maxArtifacts?: number;
        };
      };
  longRunning?: false | { maxSteps?: number; maxWallMs?: number; maxTokens?: number };
  delegation?: false | { maxDepth?: number; maxConcurrent?: number; maxChildren?: number };
  scheduling?: false | { maxPending?: number; maxHorizonMs?: number; cron?: boolean };
  providerTools?:
    false | { tools?: ProviderToolName[]; limits?: { maxCallsPerTurn?: number; maxCallsPerThread?: number } };
  /** How long an Approval may wait, in milliseconds. */
  approvals?: { timeout?: number };
  /** The largest context window an Agent here may assume. */
  context?: { window?: number };
}

/**
 * How the Harness authenticates to an MCP server: not at all, with static headers, or through an OAuth grant.
 */
export type McpAuthConfig =
  | { type: "none" }
  | { type: "static"; headers: Record<string, string> }
  | { type: "oauth"; level: "agent" | "user"; scope?: string; client?: { id: string; secret?: string } };

/**
 * One registered remote MCP server. The values under `auth.headers` are credential references, never values.
 */
export interface McpServerConfig {
  url: string;
  auth?: McpAuthConfig;
  /** Who calls the server's tools: the Harness (the default) or the model provider's own MCP connector. */
  execution?: "harness" | "provider";
  /** Non-secret headers sent on every request. */
  headers?: Record<string, string>;
  /** The server's own tool names an Agent may see. Absent means every tool. */
  allow?: string[];
  /** The server's own tool names an Agent may never see. */
  deny?: string[];
  /** Whether the server's annotations drive Approval gating. Otherwise its tools count as destructive. */
  trustAnnotations?: boolean;
  /** How long the cached Catalogue of the server stays fresh. */
  catalog?: { ttlMs?: number };
}

/** The outbound network limits of a Scope. */
export interface EgressConfig {
  /** The hostnames or `*.` globs MCP traffic may reach. Absent means any registered server. */
  mcpHosts?: string[];
}

/** One Scope's configuration, or the Deployment defaults. Both layers have the same shape. */
export interface ScopeConfigDocument {
  /** The remote MCP servers by id. */
  mcp?: { servers?: Record<string, McpServerConfig> };
  egress?: EgressConfig;
  /** The size and MIME-type limits on media entering the Scope. */
  media?: { maxBytes?: number; allowedTypes?: string[] };
  /** The Provider profiles by name. */
  providers?: Record<string, ProviderConfig>;
  ceilings?: Ceilings;
  /** Scope-wide Permission Policy rules, consulted before an Agent Spec's own. */
  policy?: PolicyRule[];
}

/** The document's shape as JSON Schema (draft 2020-12), for Platform editors. */
export const scopeConfigJsonSchema: JsonSchema = toJsonSchema(ScopeConfigSchema);

/**
 * Parses `document` as a Scope config. It checks the shape, refuses anything that looks like a secret
 * value, and, when `providers` is given, checks that every profile names a registered Provider. Fallback
 * targets must be Deployment profiles, which are `deploymentProfiles` for a Scope document and the
 * document's own profiles for the Deployment defaults. Throws `config.invalid` or `config.secret-value`.
 */
export function parseScopeConfig(
  document: unknown,
  providers?: Record<string, unknown>,
  deploymentProfiles?: Record<string, ProviderConfig>,
): ScopeConfigDocument {
  const result = z.safeParse(ScopeConfigSchema, document);
  if (!result.success) {
    const issue = firstIssue(result.error);
    const path = pointer(issue.path);
    if (issue.code === "unrecognized_keys" && issue.keys.some((key) => SECRET_LOOKING_KEY.test(key)))
      throw secretValue(path);
    // A `credential` that is not a reference is treated as a pasted value, so the error names the rule.
    if (
      issue.code === "invalid_format" &&
      (path.endsWith("/credential") || path.includes("/auth/headers/") || path.endsWith("/auth/client/secret"))
    )
      throw secretValue(path);
    throw invalid(path, issue.message);
  }
  const profiles = result.data.providers ?? {};
  const targets = deploymentProfiles ?? profiles;
  for (const [profile, { adapter, headers, fallback }] of Object.entries(profiles)) {
    if (providers && !(adapter in providers))
      throw invalid(
        `/providers/${profile}/adapter`,
        `no Provider "${adapter}" is registered in createKarmi({ providers }).`,
      );
    // A header that authenticates is a credential like any other.
    const secret = Object.keys(headers ?? {}).find((key) => SECRET_LOOKING_KEY.test(key));
    if (secret) throw secretValue(`/providers/${profile}/headers/${secret}`);
    if (fallback) {
      const target = targets[fallback.profile];
      const path = `/providers/${profile}/fallback/profile`;
      if (!target) throw invalid(path, `"${fallback.profile}" is not a Deployment Provider profile.`);
      if (target.fallback)
        throw invalid(path, `"${fallback.profile}" has a fallback of its own; fallbacks do not chain.`);
      if (target.credential !== undefined && !target.credential.startsWith("deployment:"))
        throw invalid(path, `"${fallback.profile}" must hold a deployment:<name> credential.`);
    }
  }
  for (const [id, server] of Object.entries(result.data.mcp?.servers ?? {})) checkServer(id, server);
  return result.data as ScopeConfigDocument;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The SSRF guard runs at registration so a blocked URL never reaches a transport.
function checkServer(id: string, server: { url: string; headers?: Record<string, string> | undefined }): void {
  const path = `/mcp/servers/${id}`;
  const secret = Object.keys(server.headers ?? {}).find((key) => SECRET_LOOKING_KEY.test(key));
  if (secret) throw secretValue(`${path}/headers/${secret}`);
  if (isBlockedUrl(server.url)) throw invalid(`${path}/url`, "private, reserved or malformed address.");
  const { protocol, hostname } = new URL(server.url);
  if (protocol !== "https:" && !LOOPBACK.has(hostname))
    throw invalid(`${path}/url`, "must be https (http only on loopback).");
}

function secretValue(path: string): KarmiError {
  return new KarmiError(
    "config.secret-value",
    `Secret values never enter the Scope config (at "${path}"); store them with scope.credentials.put and reference them as scope:<name>.`,
  );
}

function invalid(path: string, message: string): KarmiError {
  return new KarmiError("config.invalid", `Scope config is invalid at "${path}": ${message}`);
}

/**
 * The Provider profile an Agent Spec runs under: the one it names, else `default` when the Scope has one,
 * else the Scope's only profile. Returns undefined in every other case, which validation reports as an
 * error.
 */
export function chooseProfile(
  providerProfile: string | undefined,
  providers: Record<string, ProviderConfig>,
): { name: string; profile: ProviderConfig } | undefined {
  const names = Object.keys(providers);
  const name = providerProfile ?? ("default" in providers ? "default" : names.length === 1 ? names[0] : undefined);
  const profile = name === undefined ? undefined : providers[name];
  return name !== undefined && profile ? { name, profile } : undefined;
}

const TIER_ORDER = ["isolate", "container"] as const;
const tierRank = (tier: unknown) => TIER_ORDER.findIndex((known) => known === tier);

/**
 * The effective config of a Scope, with the Scope document layered over the Deployment defaults. Provider
 * profiles and MCP servers override by name. Numeric ceilings merge as the minimum and `false` wins.
 * Scope policy rules come before Deployment rules. MCP hosts intersect.
 */
export function resolveScopeConfig(deployment: ScopeConfigDocument, scope: ScopeConfigDocument): ScopeConfigDocument {
  const resolved: ScopeConfigDocument = {};
  if (deployment.media || scope.media) resolved.media = mergeMedia(deployment.media ?? {}, scope.media ?? {});
  if (deployment.providers || scope.providers) resolved.providers = { ...deployment.providers, ...scope.providers };
  if (deployment.ceilings || scope.ceilings)
    resolved.ceilings = mergeCeilings(deployment.ceilings ?? {}, scope.ceilings ?? {});
  if (deployment.policy || scope.policy) resolved.policy = [...(scope.policy ?? []), ...(deployment.policy ?? [])];
  if (deployment.mcp?.servers || scope.mcp?.servers)
    resolved.mcp = { servers: { ...deployment.mcp?.servers, ...scope.mcp?.servers } };
  const hosts = intersectHosts(deployment.egress?.mcpHosts, scope.egress?.mcpHosts);
  if (hosts) resolved.egress = { mcpHosts: hosts };
  return resolved;
}

// A host pattern survives only when the other side covers it, so a Scope can only narrow the Deployment
// list.
function intersectHosts(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a || !b) return a ?? b;
  const covers = (pattern: string, other: string) => matchesHost(other.replace(/^\*\./, "x."), pattern);
  const kept = [...a.filter((x) => b.some((y) => covers(y, x))), ...b.filter((y) => a.some((x) => covers(x, y)))];
  return [...new Set(kept.map((host) => host.toLowerCase()))];
}

function mergeCeilings(a: Ceilings, b: Ceilings): Ceilings {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key as keyof Ceilings];
    const y = b[key as keyof Ceilings];
    out[key] = x === false || y === false ? false : tighten(x ?? {}, y ?? {});
  }
  return out as Ceilings;
}

// Every field can only get tighter. Numbers take the minimum, booleans and tiers the more restrictive
// value, and lists the intersection.
function tighten(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined) out[key] = x ?? y;
    else if (typeof x === "number" && typeof y === "number") out[key] = Math.min(x, y);
    else if (typeof x === "boolean" && typeof y === "boolean") out[key] = x && y;
    else if (Array.isArray(x) && Array.isArray(y)) out[key] = x.filter((item) => y.includes(item));
    else if (key === "tier") out[key] = TIER_ORDER[Math.min(tierRank(x), tierRank(y))];
    else out[key] = tighten(x as Record<string, unknown>, y as Record<string, unknown>);
  }
  return out;
}

function mergeMedia(
  a: NonNullable<ScopeConfigDocument["media"]>,
  b: NonNullable<ScopeConfigDocument["media"]>,
): NonNullable<ScopeConfigDocument["media"]> {
  const allowedTypes =
    a.allowedTypes && b.allowedTypes
      ? [
          ...new Set(
            a.allowedTypes.flatMap(
              (x) => b.allowedTypes?.flatMap((y) => (matchesType(x, y) ? [y] : matchesType(y, x) ? [x] : [])) ?? [],
            ),
          ),
        ]
      : (a.allowedTypes ?? b.allowedTypes);
  return {
    maxBytes: Math.min(a.maxBytes ?? DEFAULT_MEDIA_BYTES, b.maxBytes ?? a.maxBytes ?? DEFAULT_MEDIA_BYTES),
    ...(allowedTypes && { allowedTypes }),
  };
}
