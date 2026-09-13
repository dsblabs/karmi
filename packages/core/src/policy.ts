import type { PolicyRule } from "./agent";
import { matchGlob } from "./glob";
import type { ToolAnnotations } from "./tool";

// Permission Policy evaluation: ordered rules, first match wins, no match means ask. The rule list a
// Turn evaluates is Scope rules, then Deployment rules, then the Spec's own (resolveScopeConfig
// already orders the first two); a Thread's remembered allows come before all of them.

export type PolicyEffect = PolicyRule["effect"];

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

/** The effect of the first rule that names the Tool, or a remembered allow; undefined when no rule matches. */
export function explicitEffect(
  rules: readonly PolicyRule[],
  tool: { name: string; annotations: ToolAnnotations },
  remembered?: ReadonlySet<string>,
): PolicyEffect | undefined {
  if (remembered?.has(tool.name)) return "allow";
  return rules.find((rule) => matchesRule(rule, tool))?.effect;
}
