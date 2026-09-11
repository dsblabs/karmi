import * as z from "zod/mini";
import type { AgentSpec } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import { KarmiError } from "./errors.js";
import type { FragmentContext } from "./fragment.js";
import { matchGlob } from "./glob.js";
import type { SkillInvoker } from "./skill.js";
import type { Tool } from "./tool.js";

// The Prompt: the Spec's ordered entries, each a Fragment of the turn context, evaluated for the model
// actually in use, then the Harness sections in fixed order: instructions → tool instructions →
// deferred-tool index → skills → (memory → knowledge → event, with their tickets).

/** The Harness sections that follow the Spec's instructions. */
export interface PromptSections {
  /** Tools in the model's context, for their usage instructions. */
  tools?: readonly Tool[];
  /** Deferred Tools the model has not loaded, for the names-only index. */
  deferred?: readonly string[];
  /** Every Skill of the Agent, for the always-visible index. */
  skills?: readonly { name: string; description: string; invokableBy: SkillInvoker }[];
}

export async function evaluatePrompt(
  spec: AgentSpec,
  catalogue: Catalogue,
  ctx: FragmentContext,
  sections: PromptSections = {},
): Promise<string | undefined> {
  const out: string[] = [];
  for (const entry of spec.instructions) {
    if (entry.models !== undefined && !toList(entry.models).some((glob) => matchGlob(glob, ctx.model))) continue;
    let text: string | null | undefined;
    if ("text" in entry) text = entry.text;
    else {
      const fragment = catalogue.fragments.get(entry.fragment);
      if (!fragment)
        throw new KarmiError("ref.fragment.unknown", `Fragment "${entry.fragment}" is not in the Catalogue.`);
      // Validated at put; parsed again so the Fragment sees its schema's defaults and transforms.
      const args = fragment.args ? z.parse(fragment.args, entry.args ?? {}) : undefined;
      text = await fragment.render(ctx, args);
    }
    if (text) out.push(text);
  }
  for (const tool of sections.tools ?? []) {
    const text = tool.instructions ? await tool.instructions.render(ctx, undefined) : undefined;
    if (text) out.push(text);
  }
  const index = deferredIndex(sections.deferred ?? []);
  if (index) out.push(index);
  const skills = skillIndex(sections.skills ?? []);
  if (skills) out.push(skills);
  return out.length > 0 ? out.join("\n\n") : undefined;
}

/** The names-only index of unloaded deferred Tools, grouped by where they come from. */
export function deferredIndex(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const source = toolSource(name);
    groups.set(source, [...(groups.get(source) ?? []), name]);
  }
  const lines = [
    "# Deferred tools",
    "These tools exist but are not loaded. Call `tool_search` with `select:<name>` (several names comma-separated) or with keywords to load one before calling it.",
  ];
  for (const [source, group] of groups) lines.push("", `## ${source}`, ...group.map((name) => `- ${name}`));
  return lines.join("\n");
}

/** The Skill index: every description, always visible; model-invokable ones point at `use_skill`. */
export function skillIndex(skills: PromptSections["skills"] = []): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = ["# Skills"];
  if (skills.some((skill) => skill.invokableBy !== "user"))
    lines.push(
      "Call `use_skill` with a skill's name to load its instructions and tools when its description fits the task.",
    );
  for (const skill of skills)
    lines.push(`- ${skill.name}${skill.invokableBy === "user" ? " (invoked by the user)" : ""}: ${skill.description}`);
  return lines.join("\n");
}

// An MCP Tool is named `server__tool`; everything else comes from the Catalogue.
function toolSource(name: string): string {
  const split = name.indexOf("__");
  return split > 0 ? `MCP server ${name.slice(0, split)}` : "Tools";
}

function toList(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : value;
}
