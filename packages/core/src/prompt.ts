import * as z from "zod/mini";
import type { AgentSpec } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import { KarmiError } from "./errors.js";
import type { FragmentContext } from "./fragment.js";
import { matchGlob } from "./glob.js";
import type { Tool } from "./tool.js";

// The Prompt: the Spec's ordered entries, each a Fragment of the turn context, evaluated for the model
// actually in use, then the Harness sections in fixed order: instructions → tool instructions →
// (deferred-tool index → skills → memory → knowledge → event, with their tickets).

export async function evaluatePrompt(
  spec: AgentSpec,
  catalogue: Catalogue,
  ctx: FragmentContext,
  tools: readonly Tool[] = [],
): Promise<string | undefined> {
  const sections: string[] = [];
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
    if (text) sections.push(text);
  }
  for (const tool of tools) {
    const text = tool.instructions ? await tool.instructions.render(ctx, undefined) : undefined;
    if (text) sections.push(text);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function toList(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : value;
}
