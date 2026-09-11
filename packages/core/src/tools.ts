import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import type { AgentSpec, PolicyRule } from "./agent";
import type { Catalogue } from "./catalogue";
import { deferAll, type Loaded } from "./loading";
import { evaluatePolicy, type PolicyEffect } from "./policy";
import type { ToolDefinition } from "./provider";
import { toJsonSchema } from "./schema";
import type { Skill, SkillInvoker } from "./skill";
import type { OutputLimits } from "./spill";
import type { Tool } from "./tool";

// The Tool set of one Step: the Spec's references in order, every Skill's Tools, then the Framework
// built-ins, each with its parsed settings and its Policy effect. Denied Tools are never shown to the
// model. Deferral is decided here for the whole set at once; what is loaded is the caller's `Loaded`.

export interface AvailableTool {
  tool: Tool;
  settings: unknown;
  effect: PolicyEffect;
  /** Offered through the index and `tool_search` rather than in the model's initial context. */
  deferred: boolean;
  /** The Skill this Tool belongs to; it exists only while that Skill is active. */
  skill?: string;
}

export interface ResolvedSkill {
  skill: Skill;
  invokableBy: SkillInvoker;
}

export interface ToolSet {
  available: Map<string, AvailableTool>;
  skills: ResolvedSkill[];
  loaded: Loaded;
}

export interface ToolSetInput {
  spec: AgentSpec;
  catalogue: Catalogue;
  policy: readonly PolicyRule[];
  builtIns: readonly Tool[];
  remembered?: ReadonlySet<string>;
  loaded: Loaded;
  /** The context window this Turn runs under, in tokens; the `auto` deferral threshold is a share of it. */
  window: number;
}

export function resolveToolSet({
  spec,
  catalogue,
  policy,
  builtIns,
  remembered,
  loaded,
  window,
}: ToolSetInput): ToolSet {
  const available = new Map<string, AvailableTool>();
  const deferrable: AvailableTool[] = [];
  for (const ref of spec.tools ?? []) {
    const { name, settings, alwaysLoad } =
      typeof ref === "string" ? { name: ref, settings: undefined, alwaysLoad: undefined } : ref;
    const tool = catalogue.tools.get(name);
    // MCP refs resolve at Turn start with the MCP tickets.
    if (!tool) continue;
    const entry: AvailableTool = {
      tool,
      settings: parseSettings(tool, settings),
      effect: evaluatePolicy(policy, tool, remembered),
      deferred: false,
    };
    available.set(name, entry);
    // A pinned ref stays in context; a denied Tool is never indexed, so it has nothing to defer.
    if (!alwaysLoad && entry.effect !== "deny") deferrable.push(entry);
  }
  const skills: ResolvedSkill[] = [];
  for (const ref of spec.skills ?? []) {
    const { name, invokableBy } = typeof ref === "string" ? { name: ref, invokableBy: undefined } : ref;
    const skill = catalogue.skills.get(name);
    if (!skill) continue;
    skills.push({ skill, invokableBy: invokableBy ?? skill.invokableBy });
    // Skill Tools never defer: the Skill's activation is their load point.
    for (const tool of skill.tools)
      available.set(tool.name, {
        tool,
        settings: parseSettings(tool, undefined),
        effect: evaluatePolicy(policy, tool, remembered),
        deferred: false,
        skill: name,
      });
  }
  // Framework built-ins are always allowed: they are Harness machinery, not developer actions.
  const modelSkills = skills.some((entry) => entry.invokableBy !== "user");
  for (const tool of builtIns) {
    if (tool.name === "use_skill" && !modelSkills) continue;
    available.set(tool.name, { tool, settings: undefined, effect: "allow", deferred: false });
  }
  const config = { ...AGENT_SPEC_DEFAULTS.context.tools, ...spec.context?.tools };
  if (deferAll(config, deferrable.map(definition), window)) for (const entry of deferrable) entry.deferred = true;
  return { available, skills, loaded };
}

// Validated at put; parsed again so the Tool sees its schema's defaults and transforms.
function parseSettings(tool: Tool, settings: unknown): unknown {
  return tool.settings ? z.parse(tool.settings, settings ?? {}) : undefined;
}

/** Whether the model can call this Tool now: in its initial context, loaded since, or of an active Skill. */
export function inContext(entry: AvailableTool, loaded: Loaded): boolean {
  if (entry.skill !== undefined && !loaded.skills.has(entry.skill)) return false;
  return !entry.deferred || loaded.tools.has(entry.tool.name);
}

/** What the model is offered: every Tool the Policy did not deny and no inactive Skill holds back, in a stable order. */
export function toolDefinitions({ available, loaded }: ToolSet): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const entry of available.values()) {
    if (entry.effect === "deny" || (entry.skill !== undefined && !loaded.skills.has(entry.skill))) continue;
    definitions.push(entry.deferred ? { ...definition(entry), deferred: true } : definition(entry));
  }
  return definitions;
}

/** The Tools whose usage instructions belong in the Prompt: offered and in the model's context. */
export function toolsInContext({ available, loaded }: ToolSet): Tool[] {
  return [...available.values()].flatMap((entry) =>
    entry.effect !== "deny" && inContext(entry, loaded) ? [entry.tool] : [],
  );
}

/** Deferred Tools the model has not loaded yet: what the names-only index lists. */
export function unloadedDeferred({ available, loaded }: ToolSet): string[] {
  return [...available.values()].flatMap((entry) =>
    entry.deferred && entry.effect !== "deny" && !loaded.tools.has(entry.tool.name) ? [entry.tool.name] : [],
  );
}

/** What `tool_search` searches: every deferred Tool the Policy did not deny, loaded or not. */
export function searchable({ available }: ToolSet): Tool[] {
  return [...available.values()].flatMap((entry) => (entry.deferred && entry.effect !== "deny" ? [entry.tool] : []));
}

function definition({ tool }: AvailableTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: toJsonSchema(tool.input) };
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
