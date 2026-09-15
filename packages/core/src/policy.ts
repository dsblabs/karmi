import type { NormalizedAgentSpec } from "./agent-spec";
type PolicyRule = NonNullable<NormalizedAgentSpec["policy"]>[number];
import { matchGlob } from "./glob";
import type { ToolAnnotations } from "./tool";

// Permission Policy evaluation. Rules are ordered, the first match wins and no match means ask. A Turn
// evaluates the Scope rules, then the Deployment rules, then the Spec's own, and `resolveScopeConfig`
// already orders the first two. A Thread's remembered allows come before all of them.

/** The effect of a Policy rule. */
export type PolicyEffect = PolicyRule["effect"];

/**
 * The Policy effect for one Tool: a remembered allow, the first matching rule's effect, or `ask` when nothing
 * matches.
 */
export function evaluatePolicy(
  rules: readonly PolicyRule[],
  tool: { name: string; annotations: ToolAnnotations },
  remembered?: ReadonlySet<string>,
): PolicyEffect {
  if (remembered?.has(tool.name)) return "allow";
  for (const rule of rules) {
    if (matchesRule(rule, tool)) return rule.effect;
  }
  return "ask";
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

/** The remembered allow or the effect of the first rule that names the Tool. Undefined when no rule matches. */
export function explicitEffect(
  rules: readonly PolicyRule[],
  tool: { name: string; annotations: ToolAnnotations },
  remembered?: ReadonlySet<string>,
): PolicyEffect | undefined {
  if (remembered?.has(tool.name)) return "allow";
  return rules.find((rule) => matchesRule(rule, tool))?.effect;
}
