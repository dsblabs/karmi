import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec.js";
import type { AgentSpec, PolicyRule } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import { evaluatePolicy, type PolicyEffect } from "./policy.js";
import type { ToolDefinition } from "./provider.js";
import { toJsonSchema } from "./schema.js";
import type { OutputLimits } from "./spill.js";
import type { Tool } from "./tool.js";

// The Tool set of one Turn: the Spec's references in order, then the Framework built-ins, each with
// its parsed settings and its Policy effect. Denied Tools are never shown to the model.

export interface AvailableTool {
  tool: Tool;
  settings: unknown;
  effect: PolicyEffect;
}

export function resolveTools(spec: AgentSpec, catalogue: Catalogue, policy: readonly PolicyRule[], builtIns: readonly Tool[], remembered?: ReadonlySet<string>): Map<string, AvailableTool> {
  const available = new Map<string, AvailableTool>();
  for (const ref of spec.tools ?? []) {
    const { name, settings } = typeof ref === "string" ? { name: ref, settings: undefined } : ref;
    const tool = catalogue.tools.get(name);
    // MCP refs resolve at Turn start with the MCP tickets; Skill Tools join with Skill activation.
    if (!tool) continue;
    // Validated at put; parsed again so the Tool sees its schema's defaults and transforms.
    const parsed = tool.settings ? z.parse(tool.settings, settings ?? {}) : undefined;
    available.set(name, { tool, settings: parsed, effect: evaluatePolicy(policy, tool, remembered) });
  }
  // Framework built-ins are always allowed: they are Harness machinery, not developer actions.
  for (const tool of builtIns) available.set(tool.name, { tool, settings: undefined, effect: "allow" });
  return available;
}

/** What the model is offered: every Tool the Policy did not deny, in a stable order. */
export function toolDefinitions(available: ReadonlyMap<string, AvailableTool>): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const { tool, effect } of available.values()) {
    if (effect === "deny") continue;
    definitions.push({ name: tool.name, description: tool.description, inputSchema: toJsonSchema(tool.input) });
  }
  return definitions;
}

/** The Spill limit for one Tool: the Agent's `context.toolOutput`, which the Tool's `output.max` may only lower. */
export function outputLimits(spec: AgentSpec, tool: Tool): OutputLimits {
  const defaults = AGENT_SPEC_DEFAULTS.context.toolOutput;
  const agent = spec.context?.toolOutput ?? {};
  const own = tool.output?.max ?? {};
  return {
    maxChars: Math.min(agent.maxChars ?? defaults.maxChars, own.maxChars ?? Infinity),
    maxLines: Math.min(agent.maxLines ?? defaults.maxLines, own.maxLines ?? Infinity),
  };
}
