import { KarmiError } from "./errors.js";

/** The fixed binding names the published wrangler baseline declares. */
export interface KarmiBindings {
  KARMI_THREADS: DurableObjectNamespace;
  KARMI_SCOPES: DurableObjectNamespace;
  KARMI_MEDIA?: R2Bucket;
  KARMI_QUEUE?: Queue;
  KARMI_LOADER?: WorkerLoader;
  KARMI_VECTORIZE?: VectorizeIndex;
  KARMI_AI?: Ai;
}

const BINDING_NAMES = ["KARMI_THREADS", "KARMI_SCOPES", "KARMI_MEDIA", "KARMI_QUEUE", "KARMI_LOADER", "KARMI_VECTORIZE", "KARMI_AI"] as const;
const REQUIRED = ["KARMI_THREADS", "KARMI_SCOPES"] as const;

/** Escape hatch for a Worker whose bindings cannot use the fixed names. */
export type BindingsResolver<Env = unknown> = (env: Env) => Partial<KarmiBindings>;

export function resolveBindings<Env>(env: Env, resolver?: BindingsResolver<Env>): KarmiBindings {
  const source = resolver ? resolver(env) : (env as Partial<KarmiBindings>);
  const bindings: Partial<KarmiBindings> = {};
  for (const name of BINDING_NAMES) {
    if (source[name] !== undefined) Object.assign(bindings, { [name]: source[name] });
  }
  for (const name of REQUIRED) {
    if (bindings[name] === undefined) {
      throw new KarmiError("bindings.missing", `Missing Durable Object binding ${name}; see @karmi/core/wrangler.baseline.jsonc.`);
    }
  }
  return bindings as KarmiBindings;
}
