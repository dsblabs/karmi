import * as z from "zod/mini";
import type { AgentSpec } from "./agent";
import type { Catalogue } from "./catalogue";
import { KarmiError } from "./errors";
import type { FragmentContext } from "./fragment";
import { matchGlob } from "./glob";
import type { SkillInvoker } from "./skill";
import type { Tool } from "./tool";

// The Prompt is the Spec's ordered entries, each rendered from the Turn context for the model actually in
// use, followed by the Harness sections in a fixed order: Tool instructions, the deferred-tool index, the
// Skill index, then the Memory Fragment.

/** The Harness sections that follow the Spec's instructions. */
export interface PromptSections {
  /** Provider Tools enabled for this model Step. */
  providerTools?: readonly string[];
  /** Tools in the model's context, for their usage instructions. */
  tools?: readonly Tool[];
  /** Deferred Tools the model has not loaded, for the names-only index. */
  deferred?: readonly string[];
  /** Every Skill of the Agent, for the always-visible index. */
  skills?: readonly { name: string; description: string; invokableBy: SkillInvoker }[];
  /** The rendered Memory Fragment. Absent on a user-less Thread or for an Agent without `memory`. */
  memory?: string;
}

/** Renders the Prompt for one Turn, or undefined when nothing renders. */
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
      // The args were validated at put. They are parsed again so the Fragment sees its schema's defaults
      // and transforms.
      const args = fragment.args ? z.parse(fragment.args, entry.args ?? {}) : undefined;
      text = await fragment.render(ctx, args);
    }
    if (text) out.push(text);
  }
  for (const tool of sections.tools ?? []) {
    const text = tool.instructions ? await tool.instructions.render(ctx, undefined) : undefined;
    if (text) out.push(text);
  }
  if (sections.providerTools?.length)
    out.push(
      `Provider tools enabled: ${sections.providerTools.join(", ")}. The provider executes these directly; they cannot be called from scripts.`,
    );
  const index = deferredIndex(sections.deferred ?? []);
  if (index) out.push(index);
  const skills = skillIndex(sections.skills ?? []);
  if (skills) out.push(skills);
  if (sections.memory) out.push(sections.memory);
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

/**
 * The Skill index for the Prompt. It lists every Skill's description and points model-invokable ones at
 * `use_skill`.
 */
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

// An MCP Tool is named `server__tool`. Every other Tool comes from the Catalogue.
function toolSource(name: string): string {
  const split = name.indexOf("__");
  return split > 0 ? `MCP server ${name.slice(0, split)}` : "Tools";
}

function toList(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : value;
}
