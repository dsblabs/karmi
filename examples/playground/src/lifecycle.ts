import { defineAgent, type ProviderConfig, type ScopeConfigDocument } from "@karmi/core";
import { z } from "zod";
import { decodeSample } from "./sample-data";

/** The id of the Scope lifecycle and credentials scenario. */
export const LIFECYCLE = "scopes";
/** The id of the Agent of the scenario. */
export const SCOPE_DESK = "scope-desk";
/** The Provider profile of the disposable Scope. The Agent names it, and it names the Scope credential. */
export const PROFILE = "scope-key";
/** The name of the Scope credential. The profile refers to it as `scope:provider`. */
export const CREDENTIAL = "provider";
/** The Deployment profile that `pnpm setup` configures. The fallback of the Scope profile names it. */
export const DEPLOYMENT_PROFILE = "default";

/** The prompts that the scenario suggests. The operator can edit each one. */
export const LIFECYCLE_PROMPTS = [
  { label: "Say hello", text: "Say hello in one short sentence." },
  { label: "Ask about suspension", text: "In one sentence, what happens to a Turn in a suspended Scope?" },
];

/**
 * The id of the disposable Scope for one generation of the scenario. A destroy keeps an id forever, thus a reset
 * moves to the next generation and a new id.
 */
export const disposableScope = (generation: number): string => `sample-lifecycle-${String(generation)}`;

/**
 * Defines the Agent for the model that setup selected. It runs on the profile of the disposable Scope, thus each
 * model Step resolves the Scope credential.
 */
export const scopeDeskAgent = (model: string) =>
  defineAgent({
    agentId: SCOPE_DESK,
    name: "Scope desk",
    instructions: [{ text: "You are a short assistant of the karmi Playground. Answer in one or two sentences." }],
    model: { id: model, providerProfile: PROFILE },
  });

/**
 * The Scope config of the disposable Scope. Its profile is the Deployment profile of setup, `base`, with the Scope
 * credential in place of the Deployment credential. With `fallback`, a Step without that credential runs under the
 * Deployment profile. Without setup, `base` is undefined and the profile names no adapter that exists.
 */
export function lifecycleConfig(base: ProviderConfig | undefined, fallback: boolean): ScopeConfigDocument {
  const profile: ProviderConfig = {
    ...(base ?? { adapter: "none" }),
    credential: `scope:${CREDENTIAL}`,
    ...(fallback && { fallback: { profile: DEPLOYMENT_PROFILE, on: ["missing"] } }),
  };
  return { providers: { [PROFILE]: profile } };
}

/** The last answer of `scope.providers.test`, without the Provider error details that the page does not show. */
const testSchema = z.object({
  ok: z.boolean(),
  at: z.number(),
  credential: z.optional(z.object({ ref: z.string(), source: z.string(), version: z.number() })),
  error: z.optional(z.object({ code: z.string(), message: z.string() })),
});

/** The stored sample data of the scenario. */
const lifecycleSchema = z.object({
  /** The destroy operation of the current disposable Scope, after a destroy. */
  operationId: z.optional(z.string()),
  test: z.optional(testSchema),
  /** The result of the last rewrap, by Scope id. */
  rewrap: z.optional(z.record(z.string(), z.number())),
});

/** The sample data of the scenario. */
export type LifecycleData = z.infer<typeof lifecycleSchema>;

/** Decodes the stored sample data. Data that is absent or not valid gives no operation and no result. */
export const decodeLifecycle = (data: string | undefined): LifecycleData => decodeSample(lifecycleSchema, {}, data);
