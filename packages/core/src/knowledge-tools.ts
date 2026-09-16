import * as z from "zod/mini";
import type { AgentSpec } from "./agent";
import type { KarmiBindings } from "./bindings";
import { openKnowledge } from "./knowledge";
import type { Tool } from "./tool";

/** The built-in search Tool name for a Knowledge corpus. */
export function knowledgeToolName(name: string): string {
  return `search_${name}`;
}

/** Builds a read-only, always-loaded search Tool for each searchable Knowledge reference. */
export function knowledgeTools(bindings: KarmiBindings, scope: string, spec: AgentSpec): Tool[] {
  return (spec.knowledge ?? []).flatMap((reference) => {
    const ref = typeof reference === "string" ? { name: reference } : reference;
    if (ref.mode === "inline") return [];
    const input = z.object({ query: z.string().check(z.minLength(1)) });
    const tool: Tool<typeof input, undefined> = {
      kind: "tool" as const,
      name: knowledgeToolName(ref.name),
      description: `Searches the ${ref.name} Knowledge corpus for relevant passages.`,
      input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute({ query }: z.output<typeof input>) {
        const passages = await openKnowledge(bindings, scope, ref.name).search(query, {
          ...(ref.retriever && { retriever: ref.retriever }),
          ...(ref.settings && { settings: ref.settings }),
        });
        return JSON.stringify(passages);
      },
    };
    return [tool];
  });
}

/** Renders inline corpora in Spec order, rejecting any corpus over the inline limit. */
export async function knowledgeFragments(bindings: KarmiBindings, scope: string, spec: AgentSpec): Promise<string> {
  const fragments: string[] = [];
  for (const ref of spec.knowledge ?? []) {
    if (typeof ref === "string" || ref.mode !== "inline") continue;
    fragments.push(`# Knowledge: ${ref.name}\n${await openKnowledge(bindings, scope, ref.name).inline()}`);
  }
  return fragments.join("\n\n");
}
