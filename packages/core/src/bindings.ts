import { KarmiError } from "./errors";

/** The Worker bindings karmi uses, under the fixed names the published wrangler baseline declares. */
export interface KarmiBindings {
  /** The Durable Object namespace that hosts Threads. */
  KARMI_THREADS: DurableObjectNamespace;
  /** The Durable Object namespace that hosts Scope configuration. */
  KARMI_SCOPES: DurableObjectNamespace;
  /** The R2 bucket for media and spilled Tool output. */
  KARMI_MEDIA?: R2Bucket;
  /** The queue that carries Deliverer work. */
  KARMI_QUEUE?: Queue;
  /** The Worker loader that runs Scripts in isolates. */
  KARMI_LOADER?: WorkerLoader;
  /** The Vectorize index behind the built-in Vector store. */
  KARMI_VECTORIZE?: VectorizeIndex;
  /** The Workers AI binding. */
  KARMI_AI?: Ai;
  /** The envelope store's key ring, supplied as a Worker secret. See `envelopeSecrets`. */
  KARMI_KEYRING?: string;
}

const BINDING_NAMES = [
  "KARMI_THREADS",
  "KARMI_SCOPES",
  "KARMI_MEDIA",
  "KARMI_QUEUE",
  "KARMI_LOADER",
  "KARMI_VECTORIZE",
  "KARMI_AI",
  "KARMI_KEYRING",
] as const;
const REQUIRED = ["KARMI_THREADS", "KARMI_SCOPES"] as const;

/**
 * A function that maps a Worker's own `env` onto karmi's binding names, for a Worker that cannot use the fixed
 * names.
 */
export type BindingsResolver<Env = unknown> = (env: Env) => Partial<KarmiBindings>;

/**
 * Picks karmi's bindings out of `env`, through `resolver` when one is given. Throws `bindings.missing`
 * when a required Durable Object namespace is absent.
 */
export function resolveBindings<Env>(env: Env, resolver?: BindingsResolver<Env>): KarmiBindings {
  const source = resolver ? resolver(env) : (env as Partial<KarmiBindings>);
  const bindings: Partial<KarmiBindings> = {};
  for (const name of BINDING_NAMES) {
    if (source[name] !== undefined) Object.assign(bindings, { [name]: source[name] });
  }
  for (const name of REQUIRED) {
    if (bindings[name] === undefined) {
      throw new KarmiError(
        "bindings.missing",
        `Missing Durable Object binding ${name}; see @karmi/core/wrangler.baseline.jsonc.`,
      );
    }
  }
  return bindings as KarmiBindings;
}
