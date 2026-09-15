import * as z from "zod/mini";
import type { Capabilities, PolicyRule, ProviderToolName } from "./agent";
import type { ProviderConfig } from "./scope-config";
import type { ProviderRequest } from "./provider";
import { DEFAULT_ANNOTATIONS } from "./tool";
import { explicitEffect } from "./policy";

const statelessOpenAI = z.object({ aiSdk: z.object({ openai: z.object({ store: z.literal(false) }) }) });

/** Whether a resolved profile and model support the abstract Provider Tool. */
export function supportsProviderTool(
  profile: ProviderConfig,
  model: string,
  name: ProviderToolName,
  overrides?: Record<string, unknown>,
): boolean {
  return (
    profile.adapter === "anthropic" ||
    (profile.adapter === "ai-sdk" &&
      model.startsWith("openai/") &&
      name === "web_search" &&
      !z.safeParse(statelessOpenAI, { ...profile.providerOptions, ...overrides }).success)
  );
}

/** The request grant after Policy and the remaining Turn and Thread budgets are applied. */
export function offeredProviderTools(
  grant: Capabilities["providerTools"],
  policy: PolicyRule[],
  calls: { turn: number; thread: number },
): ProviderRequest["providerTools"] {
  if (!grant) return undefined;
  const remaining = Math.min(
    (grant.limits?.maxCallsPerTurn ?? Infinity) - calls.turn,
    (grant.limits?.maxCallsPerThread ?? Infinity) - calls.thread,
  );
  const tools =
    remaining <= 0
      ? []
      : [...new Set(grant.tools)]
          .filter((name) => (explicitEffect(policy, { name, annotations: DEFAULT_ANNOTATIONS }) ?? "allow") === "allow")
          .slice(0, remaining);
  return { tools, ...(Number.isFinite(remaining) && { maxCalls: Math.max(0, remaining) }) };
}

/** Applies Scope ceilings to a Provider Tool grant, including limits omitted by the Spec. */
export function resolveProviderTools(
  grant: Capabilities["providerTools"],
  ceiling: import("./scope-config").Ceilings["providerTools"],
): Capabilities["providerTools"] {
  if (!grant || ceiling === false) return undefined;
  const max = (key: "maxCallsPerTurn" | "maxCallsPerThread") => {
    const value = Math.min(grant.limits?.[key] ?? Infinity, ceiling?.limits?.[key] ?? Infinity);
    return Number.isFinite(value) ? { [key]: value } : {};
  };
  return {
    tools: grant.tools.filter((name) => !ceiling?.tools || ceiling.tools.includes(name)),
    limits: { ...max("maxCallsPerTurn"), ...max("maxCallsPerThread") },
  };
}
