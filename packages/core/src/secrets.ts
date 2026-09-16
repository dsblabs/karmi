import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import type { ProviderErrorCode } from "./provider";
import type { ProviderConfig } from "./scope-config";

// This module is the Secrets provider seam, the path by which a Provider credential reaches a model call.
// A Provider profile names a reference (`scope:<name>` or `deployment:<name>`). The Thread resolves it
// right before each model Step and hands the adapter a Sensitive value that no log, event or snapshot
// can carry.

/** The pattern a credential reference must match: `scope:<name>` or `deployment:<name>`. */
export const CREDENTIAL_REF = /^(scope|deployment):([A-Za-z0-9_-]{1,64})$/;

/** Who owns a credential: the Scope or the Deployment. */
export type CredentialSource = "scope" | "deployment";

/** A credential reference as a Provider profile writes it, resolved under one Scope. */
export interface CredentialRef {
  scope: ScopeId;
  /** The reference, `scope:<name>` or `deployment:<name>`. */
  ref: string;
}

/** Metadata about a stored credential. It never carries the value. */
export interface CredentialInfo {
  source: CredentialSource;
  /** The version of the stored value. Every `put` increments it. */
  version: number;
  /** When the current version was stored, as epoch milliseconds. */
  updatedAt: number;
  /** When the value was revoked, as epoch milliseconds. Once set, `resolve` reports the credential missing. */
  revokedAt?: number;
}

/** A credential's metadata together with its value. */
export interface ResolvedCredential extends CredentialInfo {
  value: SensitiveValue;
}

/**
 * The store Provider credentials resolve from. The Framework ships an envelope-encrypting default over
 * the ScopeConfig Durable Object and an in-memory one in the Test kit. A Platform may supply its own.
 * Only `describe` is called outside a model call.
 */
export interface SecretsProvider {
  /** The credential `ref` names, or undefined when it is missing or revoked. */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  /** The metadata of the credential `ref` names, or undefined when there is none. */
  describe(ref: CredentialRef): Promise<CredentialInfo | undefined>;
  /** Stores a new version of the credential. A store without `put` is read-only from karmi's side. */
  put?(ref: CredentialRef, value: SensitiveValue): Promise<CredentialInfo>;
  /** Revokes the credential so that `resolve` reports it missing. */
  revoke?(ref: CredentialRef): Promise<void>;
  /** Re-wraps every credential of the Scope under the active key. It is safe to run any number of times. */
  rewrap?(scope: ScopeId): Promise<{ rewrapped: number }>;
  /** The metadata of every credential stored for the Scope, with its name. */
  list?(scope: ScopeId): Promise<(CredentialInfo & { name: string })[]>;
}

const internalStores = new WeakSet<SecretsProvider>();

/**
 * Marks `store` as the one karmi ships, whose credential rows live in the Scope's own Durable Object and go
 * with the Scope when it is destroyed. It returns `store`.
 */
export function markInternalStore<T extends SecretsProvider>(store: T): T {
  internalStores.add(store);
  return store;
}

/** Whether `store` is the Secrets provider karmi ships rather than one the Platform supplied. */
export function isInternalStore(store: SecretsProvider): boolean {
  return internalStores.has(store);
}

/** Node's custom-inspect symbol, which the Workers `console` honours too. */
export const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[SensitiveValue]";
const exposed = () =>
  new KarmiError(
    "secrets.exposed",
    "A SensitiveValue cannot be serialised or coerced; only an adapter may expose() it.",
  );

/**
 * A Sensitive value, the only form in which a credential travels inside the Framework. It cannot be
 * turned into JSON or a string, inspects as a placeholder, and loses its value under structured clone,
 * so it can only leave the process through an adapter's `expose()`.
 */
export class SensitiveValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The wrapped value. The request builder of a Provider adapter is the only intended caller. */
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

/** Wraps `value` as a Sensitive value. */
export const sensitive = (value: string): SensitiveValue => new SensitiveValue(value);

/** Whether `value` is a Sensitive value. */
export function isSensitiveValue(value: unknown): value is SensitiveValue {
  return value instanceof SensitiveValue;
}

/**
 * A copy of `value` with every Sensitive value replaced by a placeholder, which a Logger may print. It
 * walks every own enumerable property, so a value inside a class instance or an Error is replaced too.
 */
export function redact(value: unknown): unknown {
  if (isSensitiveValue(value)) return REDACTED;
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  // An object with its own `toJSON` (a Date, say) is left to serialise itself.
  if ("toJSON" in value && typeof value.toJSON === "function") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
}

/** The source and name of a credential reference, or undefined when `ref` does not match `CREDENTIAL_REF`. */
export function parseCredentialRef(ref: string): { source: CredentialSource; name: string } | undefined {
  const match = CREDENTIAL_REF.exec(ref);
  if (!match || (match[1] !== "scope" && match[1] !== "deployment") || match[2] === undefined) return undefined;
  return { source: match[1], name: match[2] };
}

/** The credential reference string for `source` and `name`. */
export const credentialRef = (source: CredentialSource, name: string): string => `${source}:${name}`;

/**
 * A Secrets provider that answers `deployment:<name>` references from `credentials` and passes everything
 * else to `store`.
 */
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
  // The methods are delegated one by one because a spread would drop the prototype methods of a
  // class-based store.
  const { put, revoke, rewrap, list } = store;
  const layered: SecretsProvider = {
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
  return isInternalStore(store) ? markInternalStore(layered) : layered;
}

/** The values a model call is authenticated with, resolved from a Provider profile just before the call. */
export interface ProviderCredentials {
  /** The Provider's own credential (`credential`). */
  provider?: SensitiveValue;
  /** The gateway's own access token (`gateway.credential`). */
  gateway?: SensitiveValue;
}

/**
 * What a Step records about the credential it ran under: the reference, its source and version, never the
 * value.
 */
export interface CredentialUse {
  ref: string;
  source: CredentialSource;
  version: number;
}

/** The credentials of a Provider profile, or the first reference the store could not answer. */
export type ProfileCredentials =
  { ok: true; credentials: ProviderCredentials; use?: CredentialUse } | { ok: false; missing: string };

/**
 * Resolves the credential references of `profile` under `scope`. `missing` names the first reference the store
 * cannot answer.
 */
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

/** Every reason a Credential fallback can engage for. */
export const FALLBACK_REASONS = ["missing", "auth", "quota", "rate_limit", "unavailable"] as const;
/** The reason a Credential fallback engaged. */
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** The fallback reason that `code` maps to, or undefined when the error is not a credential problem. */
export function fallbackReason(code: ProviderErrorCode): Exclude<FallbackReason, "missing"> | undefined {
  return code === "auth" || code === "quota" || code === "rate_limit" || code === "unavailable" ? code : undefined;
}

/**
 * The record a Thread keeps once a Step fell back after a Provider error. The rest of the Turn stays on the
 * fallback.
 */
export interface FallbackEngaged {
  /** The model Step that engaged the fallback. */
  step: number;
  /** The attempt within that Step that engaged it. */
  attempt: number;
  reason: Exclude<FallbackReason, "missing">;
}

/**
 * The model and profile the `attempt`-th try of model Step `step` runs, or undefined when the attempts
 * are exhausted. The Spec's models are tried in order, each on the primary profile until the attempt
 * that engaged the fallback, then every remaining candidate on the fallback profile. Later Steps of the
 * same Turn start on the fallback.
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
