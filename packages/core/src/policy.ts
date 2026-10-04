import type { NormalizedAgentSpec } from "./agent-spec";
type PolicyRule = NonNullable<NormalizedAgentSpec["policy"]>[number];
import { matchGlob } from "./glob";
import type { ToolAnnotations } from "./tool";

// Permission Policy evaluation. Rules are ordered, the first match wins and no match means ask. A Turn
// evaluates the Scope rules, then the Deployment rules, then the Spec's own, and `resolveScopeConfig`
// already orders the first two. A remembered allow of the Thread changes only the effect `ask` to `allow`,
// so a `deny` rule wins over it.

/** The effect of a Policy rule. */
export type PolicyEffect = PolicyRule["effect"];

/**
 * The Policy effect for one Tool: the first matching rule's effect, or `ask` when nothing matches. A
 * remembered allow changes `ask` to `allow`. It never changes a `deny`.
 */
export function evaluatePolicy(
  rules: readonly PolicyRule[],
  tool: { name: string; annotations: ToolAnnotations },
  remembered?: ReadonlySet<string>,
): PolicyEffect {
  return explicitEffect(rules, tool, remembered) ?? "ask";
}

function matchesRule(rule: PolicyRule, tool: { name: string; annotations: ToolAnnotations }): boolean {
  const { tool: globs, annotations } = rule.match;
  if (globs !== undefined && !(Array.isArray(globs) ? globs : [globs]).some((glob) => matchGlob(glob, tool.name)))
    return false;
  if (annotations !== undefined) {
    for (const [key, value] of Object.entries(annotations)) {
      if (value !== undefined && tool.annotations[key as keyof ToolAnnotations] !== value) return false;
    }
  }
  return true;
}

/**
 * The effect of the first rule that matches the Tool, where a remembered allow changes `ask` to `allow`.
 * With no matching rule, it is `allow` for a remembered name and undefined for each other name.
 */
export function explicitEffect(
  rules: readonly PolicyRule[],
  tool: { name: string; annotations: ToolAnnotations },
  remembered?: ReadonlySet<string>,
): PolicyEffect | undefined {
  const effect = rules.find((rule) => matchesRule(rule, tool))?.effect;
  if (effect === "deny" || effect === "allow") return effect;
  return remembered?.has(tool.name) ? "allow" : effect;
}
