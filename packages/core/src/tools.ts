import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import type { AgentSpec, PolicyRule } from "./agent";
import type { Catalogue } from "./catalogue";
import { deferAll, type Loaded } from "./loading";
import { parseMcpReference, type McpReference } from "./mcp-catalog";
import type { McpToolSource } from "./mcp-source";
import { evaluatePolicy, explicitEffect, type PolicyEffect } from "./policy";
import type { ToolDefinition } from "./provider";
import { toJsonSchema } from "./schema";
import type { Skill, SkillInvoker } from "./skill";
import type { OutputLimits } from "./spill";
import type { Tool } from "./tool";

// The Tool set of one Step. It holds the Spec's Catalogue references in order, then its MCP servers' tools
// grouped by server in id order, then every Skill's Tools, then the Framework built-ins, each with its
// parsed settings and its Policy effect. Denied Tools are never shown to the model. Deferral is decided
// here for the whole set at once. What the model has loaded comes from the caller's `Loaded`.

/** One Tool of a Step's Tool set, with its parsed settings, its Policy effect and its deferral state. */
export interface AvailableTool {
  /** True for a user-level MCP Tool served from cache on a user-less Thread. Scripts omit such a Tool and say why. */
  scriptUnavailable?: boolean;
  tool: Tool;
  settings: unknown;
  effect: PolicyEffect;
  /** True when the Tool is offered through the deferred index and `tool_search` rather than in the initial context. */
  deferred: boolean;
  /** The name of the Skill this Tool belongs to. The Tool exists only while that Skill is active. */
  skill?: string;
}

/** A Skill the Spec references, with who may invoke it after the reference's override. */
export interface ResolvedSkill {
  skill: Skill;
  invokableBy: SkillInvoker;
}

/** The Tools and Skills of one Step, and what the model has loaded. */
export interface ToolSet {
  /** Every Tool by name, denied ones included. */
  available: Map<string, AvailableTool>;
  skills: ResolvedSkill[];
  loaded: Loaded;
}

/** What `resolveToolSet` needs. */
export interface ToolSetInput {
  spec: AgentSpec;
  catalogue: Catalogue;
  /** The Policy rules in evaluation order. */
  policy: readonly PolicyRule[];
  builtIns: readonly Tool[];
  /** Tool names the Thread remembered an allow for. */
  remembered?: ReadonlySet<string>;
  /** The Turn's resolved MCP servers. Absent when the Spec references none. */
  mcp?: McpToolSource;
  loaded: Loaded;
  /** The context window this Turn runs under, in tokens. The `auto` deferral threshold is a share of it. */
  window: number;
}

const POLICED_BUILT_INS = new Set(["schedule", "remember", "recall"]);

/** Builds the Tool set of one Step from the Spec, the Catalogue, the MCP servers and the built-ins. */
export function resolveToolSet({
  spec,
  catalogue,
  policy,
  builtIns,
  remembered,
  mcp,
  loaded,
  window,
}: ToolSetInput): ToolSet {
  const available = new Map<string, AvailableTool>();
  const deferrable: AvailableTool[] = [];
  const mcpRefs: { ref: McpReference; alwaysLoad: boolean }[] = [];
  // A pinned ref stays in context. A denied Tool is never indexed, so it has nothing to defer.
  const offer = (tool: Tool, settings: unknown, alwaysLoad: boolean | undefined) => {
    const entry: AvailableTool = { tool, settings, effect: evaluatePolicy(policy, tool, remembered), deferred: false };
    if (mcp?.scriptUnavailable?.(tool.name)) entry.scriptUnavailable = true;
    available.set(tool.name, entry);
    if (!alwaysLoad && entry.effect !== "deny") deferrable.push(entry);
  };
  for (const ref of spec.tools ?? []) {
    const { name, settings, alwaysLoad } =
      typeof ref === "string" ? { name: ref, settings: undefined, alwaysLoad: undefined } : ref;
    const mcpRef = parseMcpReference(name);
    if (mcpRef) {
      mcpRefs.push({ ref: mcpRef, alwaysLoad: alwaysLoad === true });
      continue;
    }
    const tool = catalogue.tools.get(name);
    if (tool) offer(tool, parseSettings(tool, settings), alwaysLoad);
  }
  // Grouped by server in id order, so one server's change only moves its own slice of the prefix.
  mcpRefs.sort((a, b) => (a.ref.server < b.ref.server ? -1 : a.ref.server > b.ref.server ? 1 : 0));
  for (const { ref, alwaysLoad } of mcpRefs)
    for (const tool of mcp?.tools(ref) ?? []) offer(tool, undefined, alwaysLoad);
  const skills: ResolvedSkill[] = [];
  for (const ref of spec.skills ?? []) {
    const { name, invokableBy } = typeof ref === "string" ? { name: ref, invokableBy: undefined } : ref;
    const skill = catalogue.skills.get(name);
    if (!skill) continue;
    skills.push({ skill, invokableBy: invokableBy ?? skill.invokableBy });
    // Skill Tools never defer. The Skill's activation is their Load point.
    for (const tool of skill.tools)
      available.set(tool.name, {
        tool,
        settings: parseSettings(tool, undefined),
        effect: evaluatePolicy(policy, tool, remembered),
        deferred: false,
        skill: name,
      });
  }
  // Framework built-ins are allowed by default because they are Harness machinery, not developer actions.
  // `schedule`, `remember` and `recall` act on the Agent's behalf, so a Policy rule that names one of them
  // applies and may `ask`.
  const modelSkills = skills.some((entry) => entry.invokableBy !== "user");
  for (const tool of builtIns) {
    if (tool.name === "use_skill" && !modelSkills) continue;
    const effect = builtInEffect(tool, policy, remembered);
    available.set(tool.name, { tool, settings: undefined, effect, deferred: false });
  }
  const config = { ...AGENT_SPEC_DEFAULTS.context.tools, ...spec.context?.tools };
  if (deferAll(config, deferrable.map(definition), window)) for (const entry of deferrable) entry.deferred = true;
  return { available, skills, loaded };
}

function builtInEffect(tool: Tool, policy: readonly PolicyRule[], remembered?: ReadonlySet<string>): PolicyEffect {
  const policed = POLICED_BUILT_INS.has(tool.name) || tool.name.startsWith("search_");
  return (policed && explicitEffect(policy, tool, remembered)) || "allow";
}

// The settings were validated at put. They are parsed again so the Tool sees its schema's defaults and transforms.
function parseSettings(tool: Tool, settings: unknown): unknown {
  return tool.settings ? z.parse(tool.settings, settings ?? {}) : undefined;
}

/**
 * Whether the model can call this Tool now: it is in the initial context, was loaded since, or belongs to an
 * active Skill.
 */
export function inContext(entry: AvailableTool, loaded: Loaded): boolean {
  if (entry.skill !== undefined && !loaded.skills.has(entry.skill)) return false;
  return !entry.deferred || loaded.tools.has(entry.tool.name);
}

/**
 * The Tool definitions the model is offered, in a stable order. Denied Tools and Tools of inactive Skills
 * are left out.
 */
export function toolDefinitions({ available, loaded }: ToolSet): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const entry of available.values()) {
    if (entry.effect === "deny" || (entry.skill !== undefined && !loaded.skills.has(entry.skill))) continue;
    definitions.push(entry.deferred ? { ...definition(entry), deferred: true } : definition(entry));
  }
  return definitions;
}

/**
 * The Tools whose usage instructions belong in the Prompt. They are the offered Tools that are in the
 * model's context.
 */
export function toolsInContext({ available, loaded }: ToolSet): Tool[] {
  return [...available.values()].flatMap((entry) =>
    entry.effect !== "deny" && inContext(entry, loaded) ? [entry.tool] : [],
  );
}

/** The names of the deferred Tools the model has not loaded yet. The names-only index in the Prompt lists them. */
export function unloadedDeferred({ available, loaded }: ToolSet): string[] {
  return [...available.values()].flatMap((entry) =>
    entry.deferred && entry.effect !== "deny" && !loaded.tools.has(entry.tool.name) ? [entry.tool.name] : [],
  );
}

/** The Tools `tool_search` searches. Every deferred Tool the Policy did not deny is included, loaded or not. */
export function searchable({ available }: ToolSet): Tool[] {
  return [...available.values()].flatMap((entry) => (entry.deferred && entry.effect !== "deny" ? [entry.tool] : []));
}

function definition({ tool }: AvailableTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: toJsonSchema(tool.input) };
}

/**
 * The Spill limit for one Tool. It is the Agent's `context.toolOutput`, lowered wherever the Tool's own
 * `output.max` is smaller.
 */
export function outputLimits(spec: AgentSpec, tool: Pick<Tool, "output">): OutputLimits {
  const defaults = AGENT_SPEC_DEFAULTS.context.toolOutput;
  const agent = spec.context?.toolOutput ?? {};
  const own = tool.output?.max ?? {};
  return {
    maxChars: Math.min(agent.maxChars ?? defaults.maxChars, own.maxChars ?? Infinity),
    maxLines: Math.min(agent.maxLines ?? defaults.maxLines, own.maxLines ?? Infinity),
  };
}
