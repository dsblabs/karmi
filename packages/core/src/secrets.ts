import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import type { ProviderErrorCode } from "./provider";
import type { ProviderConfig } from "./scope-config";

// The SecretsProvider seam: how a Provider credential reaches a model call. A profile names a reference
// (`scope:<name>` or `deployment:<name>`); the Thread resolves it right before each model Step and hands
// the adapter a SensitiveValue that no log, event or snapshot can carry.

export const CREDENTIAL_REF = /^(scope|deployment):([A-Za-z0-9_-]{1,64})$/;

export type CredentialSource = "scope" | "deployment";

/** A credential reference as a profile writes it, resolved under one Scope. */
export interface CredentialRef {
  scope: ScopeId;
  /** `scope:<name>` or `deployment:<name>`. */
  ref: string;
}

/** Metadata about a stored credential; never its value. */
export interface CredentialInfo {
  source: CredentialSource;
  version: number;
  updatedAt: number;
  /** Set once the value has been revoked; `resolve` then reports it missing. */
  revokedAt?: number;
}

export interface ResolvedCredential extends CredentialInfo {
  value: SensitiveValue;
}

/**
 * Where Provider credentials live. The Framework ships an envelope-encrypting default over the ScopeConfig
 * Durable Object and an in-memory one in the test kit; a Platform may supply its own. `resolve` answers
 * `undefined` for a missing or revoked credential; only `describe` is consulted outside a model call.
 */
export interface SecretsProvider {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  describe(ref: CredentialRef): Promise<CredentialInfo | undefined>;
  /** Stores a new version; a store without one is read-only from karmi's side. */
  put?(ref: CredentialRef, value: SensitiveValue): Promise<CredentialInfo>;
  revoke?(ref: CredentialRef): Promise<void>;
  /** Re-wraps every credential of the Scope under the active key; safe to run any number of times. */
  rewrap?(scope: ScopeId): Promise<{ rewrapped: number }>;
  list?(scope: ScopeId): Promise<(CredentialInfo & { name: string })[]>;
}

/** Node's custom-inspect hook, which Workers' `console` honours too. */
export const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[SensitiveValue]";
const exposed = () =>
  new KarmiError(
    "secrets.exposed",
    "A SensitiveValue cannot be serialised or coerced; only an adapter may expose() it.",
  );

/**
 * A secret in flight. It cannot be turned into JSON or a string, inspects as a placeholder, and loses
 * its value under structured clone, so it can only leave the process through an adapter's `expose()`.
 */
export class SensitiveValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The one way out; the request builder of a Provider adapter is the only intended caller. */
  expose(): string {
    return this.#value;
  }

  toJSON(): never {
    throw exposed();
  }

  toString(): never {
    throw exposed();
  }

  [Symbol.toPrimitive](): never {
    throw exposed();
  }

  [INSPECT](): string {
    return REDACTED;
  }
}

export const sensitive = (value: string): SensitiveValue => new SensitiveValue(value);

export function isSensitiveValue(value: unknown): value is SensitiveValue {
  return value instanceof SensitiveValue;
}

/**
 * The same structure with every SensitiveValue replaced by a placeholder; what a Logger may print. Walks
 * every own enumerable property, so a value tucked into a class instance or an Error is caught too.
 */
export function redact(value: unknown): unknown {
  if (isSensitiveValue(value)) return REDACTED;
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  // Anything that serialises itself (a Date, say) is left to do so.
  if ("toJSON" in value && typeof value.toJSON === "function") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
}

export function parseCredentialRef(ref: string): { source: CredentialSource; name: string } | undefined {
  const match = CREDENTIAL_REF.exec(ref);
  if (!match || (match[1] !== "scope" && match[1] !== "deployment") || match[2] === undefined) return undefined;
  return { source: match[1], name: match[2] };
}

export const credentialRef = (source: CredentialSource, name: string): string => `${source}:${name}`;

/** Deployment credentials from `createKarmi({ credentials })` answer `deployment:<name>` before the store is asked. */
export function layerDeploymentCredentials(
  credentials: Record<string, string> | undefined,
  store: SecretsProvider,
): SecretsProvider {
  if (!credentials || Object.keys(credentials).length === 0) return store;
  const held = new Map(Object.entries(credentials).map(([name, value]) => [name, sensitive(value)]));
  const info: CredentialInfo = { source: "deployment", version: 1, updatedAt: 0 };
  const fromDeployment = (ref: CredentialRef): SensitiveValue | undefined => {
    const parsed = parseCredentialRef(ref.ref);
    return parsed?.source === "deployment" ? held.get(parsed.name) : undefined;
  };
  // Delegated method by method: a spread would drop the prototype methods of a class-based store.
  const { put, revoke, rewrap, list } = store;
  return {
    resolve: async (ref) => {
      const value = fromDeployment(ref);
      return value ? { ...info, value } : store.resolve(ref);
    },
    describe: async (ref) => (fromDeployment(ref) ? info : store.describe(ref)),
    ...(put && { put: (ref, value) => put.call(store, ref, value) }),
    ...(revoke && { revoke: (ref) => revoke.call(store, ref) }),
    ...(rewrap && { rewrap: (scope) => rewrap.call(store, scope) }),
    ...(list && { list: (scope) => list.call(store, scope) }),
  };
}

// What a model call is authenticated with, resolved from a Provider profile just before the call.

export interface ProviderCredentials {
  provider?: SensitiveValue;
  /** The gateway's own access token (`gateway.credential`). */
  gateway?: SensitiveValue;
}

/** What a Step records about the credential it ran under: which one and which version, never the value. */
export interface CredentialUse {
  ref: string;
  source: CredentialSource;
  version: number;
}

export type ProfileCredentials =
  { ok: true; credentials: ProviderCredentials; use?: CredentialUse } | { ok: false; missing: string };

/** Resolves a profile's credential references; `missing` names the first reference the store cannot answer. */
export async function resolveProfileCredentials(
  secrets: SecretsProvider,
  scope: ScopeId,
  profile: ProviderConfig,
): Promise<ProfileCredentials> {
  const credentials: ProviderCredentials = {};
  let use: CredentialUse | undefined;
  if (profile.credential !== undefined) {
    const resolved = await secrets.resolve({ scope, ref: profile.credential });
    if (!resolved) return { ok: false, missing: profile.credential };
    credentials.provider = resolved.value;
    use = { ref: profile.credential, source: resolved.source, version: resolved.version };
  }
  if (profile.gateway?.credential !== undefined) {
    const resolved = await secrets.resolve({ scope, ref: profile.gateway.credential });
    if (!resolved) return { ok: false, missing: profile.gateway.credential };
    credentials.gateway = resolved.value;
  }
  return { ok: true, credentials, ...(use && { use }) };
}

// Opt-in fallback from a Scope's own credential to a Deployment profile, with a closed list of reasons.

export const FALLBACK_REASONS = ["missing", "auth", "quota", "rate_limit", "unavailable"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** The Provider error codes that double as fallback reasons; anything else is not a credential problem. */
export function fallbackReason(code: ProviderErrorCode): Exclude<FallbackReason, "missing"> | undefined {
  return code === "auth" || code === "quota" || code === "rate_limit" || code === "unavailable" ? code : undefined;
}

/** Recorded on the Thread once a Step fell back after a Provider error; the rest of the Turn stays on the fallback. */
export interface FallbackEngaged {
  step: number;
  attempt: number;
  reason: Exclude<FallbackReason, "missing">;
}

/**
 * Which model and profile the `attempt`-th try of model Step `step` runs: the Spec's models in order,
 * each on the primary profile until the attempt that engaged the fallback, then every remaining
 * candidate on the fallback profile. Later Steps of the same Turn start on the fallback.
 */
export function attemptTarget(
  models: readonly string[],
  engaged: FallbackEngaged | undefined,
  step: number,
  attempt: number,
): { model: string; fallback: boolean } | undefined {
  const candidates = models.flatMap((model, i) => {
    if (!engaged || step < engaged.step) return [{ model, fallback: false }];
    if (step > engaged.step || i > engaged.attempt - 1) return [{ model, fallback: true }];
    if (i === engaged.attempt - 1)
      return [
        { model, fallback: false },
        { model, fallback: true },
      ];
    return [{ model, fallback: false }];
  });
  return candidates[attempt - 1];
}
