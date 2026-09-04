import * as z from "zod/mini";
import { CapabilityLimitSchemas, name, PolicyRuleSchema, positiveInt, ProviderToolNameSchema, ScriptTierSchema } from "./agent-spec.js";
import type { PolicyRule, ProviderToolName } from "./agent.js";
import { KarmiError } from "./errors.js";
import { toJsonSchema, type JsonSchema } from "./schema.js";
import { pointer } from "./validate.js";

// The secret-free Scope document: what `scope.config.set` stores as one immutable revision, and what
// `createKarmi({ defaults })` supplies as the Deployment layer every Scope inherits and may only tighten.

// A credential is always a reference into a secret store; a value here is the one thing this schema exists to refuse.
const CREDENTIAL_REF = /^(scope|deployment):[A-Za-z0-9_-]{1,64}$/;
const SECRET_LOOKING_KEY = /key|secret|token|password/i;

const credentialRef = z.string().check(z.regex(CREDENTIAL_REF, "must be scope:<name> or deployment:<name>, never a value"));

// Cloudflare AI Gateway is configuration under any adapter: a URL plus `cf-aig-*` headers. Bounds are the gateway's own.
const GatewaySchema = z.strictObject({
  kind: z.literal("cloudflare"),
  accountId: name,
  gatewayId: name,
  /** The `cf-aig-authorization` token; absent for an unauthenticated gateway. */
  credential: z.optional(credentialRef),
  /** The provider key is stored in the gateway, so the profile carries none. */
  byok: z.optional(z.boolean()),
  metadata: z.optional(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).check(z.refine((metadata) => Object.keys(metadata).length <= 5, "at most 5 entries"))),
  cache: z.optional(z.strictObject({ ttl: z.optional(positiveInt), skip: z.optional(z.boolean()), key: z.optional(z.string()) })),
  retry: z.optional(z.strictObject({ maxAttempts: z.optional(z.int().check(z.minimum(1), z.maximum(5))), delayMs: z.optional(z.int().check(z.minimum(0), z.maximum(5000))), backoff: z.optional(z.enum(["constant", "linear", "exponential"])) })),
  timeoutMs: z.optional(positiveInt),
});

const ProviderConfigSchema = z.strictObject({
  /** Name of a Provider registered in `createKarmi({ providers })`. */
  adapter: name,
  /** Model-id globs this profile can serve; defaults to `<adapter>/*`. */
  models: z.optional(z.array(z.string().check(z.minLength(1)))),
  credential: z.optional(credentialRef),
  /** Self-hosted or OpenAI-compatible endpoints; ignored when a gateway is set. */
  baseUrl: z.optional(z.url()),
  gateway: z.optional(GatewaySchema),
  /** Who summarises at Compaction: the Harness (default) or the provider's own mechanism. */
  compaction: z.optional(z.enum(["harness", "provider"])),
  /** Only `inline` (base64 at request-build) exists in v0; the key is reserved for URL/file strategies. */
  media: z.optional(z.strictObject({ strategy: z.literal("inline") })),
  /** Adapter-namespaced options forwarded verbatim, e.g. `{ anthropic: { effort: "high" } }`. */
  providerOptions: z.optional(z.record(z.string(), z.unknown())),
  headers: z.optional(z.record(z.string(), z.string())),
});

// `false` switches a Capability off for the Scope; an absent block leaves it unbounded.
const ceiling = <T extends z.core.$ZodType>(schema: T) => z.optional(z.union([z.literal(false), schema]));
const CeilingsSchema = z.strictObject({
  scripts: ceiling(z.strictObject({ tier: z.optional(ScriptTierSchema), limits: z.optional(CapabilityLimitSchemas.scripts) })),
  longRunning: ceiling(CapabilityLimitSchemas.longRunning),
  delegation: ceiling(CapabilityLimitSchemas.delegation),
  scheduling: ceiling(z.extend(CapabilityLimitSchemas.scheduling, { cron: z.optional(z.boolean()) })),
  providerTools: ceiling(z.strictObject({ tools: z.optional(z.array(ProviderToolNameSchema)), limits: z.optional(CapabilityLimitSchemas.providerTools) })),
  approvals: z.optional(z.strictObject({ timeout: z.optional(positiveInt) })),
});

export const ScopeConfigSchema = z.strictObject({
  providers: z.optional(z.record(name, ProviderConfigSchema)),
  ceilings: z.optional(CeilingsSchema),
  policy: z.optional(z.array(PolicyRuleSchema)),
});

export interface GatewayConfig {
  kind: "cloudflare";
  accountId: string;
  gatewayId: string;
  credential?: string;
  byok?: boolean;
  metadata?: Record<string, string | number | boolean>;
  cache?: { ttl?: number; skip?: boolean; key?: string };
  retry?: { maxAttempts?: number; delayMs?: number; backoff?: "constant" | "linear" | "exponential" };
  timeoutMs?: number;
}

/** One Provider profile: an adapter, what it may serve, and how the adapter reaches the provider. Secret-free. */
export interface ProviderConfig {
  adapter: string;
  models?: string[];
  credential?: string;
  baseUrl?: string;
  gateway?: GatewayConfig;
  compaction?: "harness" | "provider";
  media?: { strategy: "inline" };
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Upper bounds on what an Agent Spec in this Scope may ask for; `false` makes the Capability unavailable. */
export interface Ceilings {
  scripts?: false | { tier?: "isolate" | "container"; limits?: { cpuMs?: number; wallMs?: number; maxToolCalls?: number; idleMs?: number; jobMaxWallMs?: number; maxArtifacts?: number } };
  longRunning?: false | { maxSteps?: number; maxWallMs?: number; maxTokens?: number };
  delegation?: false | { maxDepth?: number; maxConcurrent?: number; maxChildren?: number };
  scheduling?: false | { maxPending?: number; maxHorizonMs?: number; cron?: boolean };
  providerTools?: false | { tools?: ProviderToolName[]; limits?: { maxCallsPerTurn?: number; maxCallsPerThread?: number } };
  approvals?: { timeout?: number };
}

/** One Scope's configuration, or the Deployment defaults: the same shape at both layers. */
export interface ScopeConfigDocument {
  providers?: Record<string, ProviderConfig>;
  ceilings?: Ceilings;
  /** Scope-wide Permission Policy rules, consulted before an Agent Spec's own. */
  policy?: PolicyRule[];
}

/** The document's shape as JSON Schema (draft 2020-12), for Platform editors. */
export const scopeConfigJsonSchema: JsonSchema = toJsonSchema(ScopeConfigSchema);

/** Checks the document's shape and, when the registered Providers are given, that every profile names one of them. */
export function parseScopeConfig(document: unknown, providers?: Record<string, unknown>): ScopeConfigDocument {
  const result = z.safeParse(ScopeConfigSchema, document);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = pointer(issue.path);
    if (issue.code === "unrecognized_keys" && issue.keys.some((key) => SECRET_LOOKING_KEY.test(key))) {
      throw new KarmiError("config.secret-value", `Secret values never enter the Scope config (at "${path}"); store them with scope.credentials.put and reference them as scope:<name>.`);
    }
    throw invalid(path, issue.message);
  }
  for (const [profile, { adapter, headers }] of Object.entries(result.data.providers ?? {})) {
    if (providers && !(adapter in providers)) throw invalid(`/providers/${profile}/adapter`, `no Provider "${adapter}" is registered in createKarmi({ providers }).`);
    // A header that authenticates is a credential like any other.
    const secret = Object.keys(headers ?? {}).find((key) => SECRET_LOOKING_KEY.test(key) || /authorization/i.test(key));
    if (secret) throw new KarmiError("config.secret-value", `Secret values never enter the Scope config (at "/providers/${profile}/headers/${secret}"); store them with scope.credentials.put and reference them as scope:<name>.`);
  }
  return result.data as ScopeConfigDocument;
}

function invalid(path: string, message: string): KarmiError {
  return new KarmiError("config.invalid", `Scope config is invalid at "${path}": ${message}`);
}

const TIER_ORDER = ["isolate", "container"] as const;

/**
 * Deployment defaults under the Scope document: Provider profiles override by name, numeric ceilings
 * merge as the minimum, `false` wins, Scope policy rules come first.
 */
export function resolveScopeConfig(deployment: ScopeConfigDocument, scope: ScopeConfigDocument): ScopeConfigDocument {
  const resolved: ScopeConfigDocument = {};
  if (deployment.providers || scope.providers) resolved.providers = { ...deployment.providers, ...scope.providers };
  if (deployment.ceilings || scope.ceilings) resolved.ceilings = mergeCeilings(deployment.ceilings ?? {}, scope.ceilings ?? {});
  if (deployment.policy || scope.policy) resolved.policy = [...(scope.policy ?? []), ...(deployment.policy ?? [])];
  return resolved;
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

// Field-wise "only tighter": numbers take the minimum, booleans and tiers the more restrictive, lists the intersection.
function tighten(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined) out[key] = x ?? y;
    else if (typeof x === "number" && typeof y === "number") out[key] = Math.min(x, y);
    else if (typeof x === "boolean" && typeof y === "boolean") out[key] = x && y;
    else if (Array.isArray(x) && Array.isArray(y)) out[key] = x.filter((item) => y.includes(item));
    else if (key === "tier") out[key] = TIER_ORDER[Math.min(TIER_ORDER.indexOf(x as never), TIER_ORDER.indexOf(y as never))];
    else out[key] = tighten(x as Record<string, unknown>, y as Record<string, unknown>);
  }
  return out;
}
