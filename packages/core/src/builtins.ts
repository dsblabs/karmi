import * as z from "zod/mini";
import type { FragmentContext } from "./fragment";
import { keys } from "./keys";
import type { Skill } from "./skill";
import { searchTools, SEARCH_LIMIT } from "./loading";
import type { ThreadEventData } from "./thread-events";
import type { Tool, ToolContent, ToolResult } from "./tool";
import { searchable, type ToolSet } from "./tools";

// The Framework's built-in Tools. They have the same shape as a Catalogue Tool, but the Harness mints them
// rather than a developer, so they bypass the name check that reserves their names.

/** The Harness services a built-in Tool uses. The Thread Durable Object is the one implementation. */
export interface BuiltInHost {
  scope: string;
  threadId: string;
  bucket: R2Bucket | undefined;
  /** The Tool set of the Step in flight. */
  tools(): ToolSet;
  /** The Fragment context of the Turn, for rendering a Skill body. */
  fragmentContext(): FragmentContext;
  /** Appends a Harness Event to the Turn. A built-in creates a Load point by appending `tools.loaded`. */
  append(data: ThreadEventData): void;
}

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** Every built-in Tool in offer order. `resolveToolSet` drops the ones the Spec gives no use. */
export function builtInTools(host: BuiltInHost): Tool[] {
  return [readOutputTool(host), toolSearchTool(host), useSkillTool(host)];
}

const ReadOutputInput = z.object({
  ref: z.string().check(z.regex(/^\d+$/, "a ref is the id named in a truncation marker")),
  offset: z.optional(z.int().check(z.nonnegative())),
  limit: z.optional(z.int().check(z.positive())),
});

/**
 * The `read_output` built-in. It re-reads a spilled Tool result of this Thread by the ref its truncation
 * marker names.
 */
export function readOutputTool({ bucket, scope, threadId }: BuiltInHost): Tool<typeof ReadOutputInput, undefined> {
  return Object.freeze({
    kind: "tool",
    name: "read_output",
    description:
      "Reads the full output of an earlier tool result that was truncated. `ref` is the id named in the truncation marker; `offset` and `limit` select lines (0-based).",
    input: ReadOutputInput,
    annotations: READ_ONLY,
    async execute({ ref, offset = 0, limit }: z.output<typeof ReadOutputInput>): Promise<string | ToolResult> {
      const object = bucket ? await bucket.get(keys.toolOutput(scope, threadId, Number(ref))) : null;
      if (!object)
        return { content: [{ type: "text", text: `No stored output "${ref}" on this Thread.` }], isError: true };
      const lines = (await object.text()).split("\n");
      const page = lines.slice(offset, limit === undefined ? undefined : offset + limit);
      return page.length > 0
        ? page.join("\n")
        : `Output "${ref}" has ${lines.length} lines; nothing at offset ${offset}.`;
    },
  });
}

const ToolSearchInput = z.object({ query: z.string().check(z.minLength(1)) });

/** The `tool_search` built-in. It finds deferred Tools by name or keyword and loads the matches. */
export function toolSearchTool(host: BuiltInHost): Tool<typeof ToolSearchInput, undefined> {
  return Object.freeze({
    kind: "tool",
    name: "tool_search",
    description: `Loads tools from the deferred index so you can call them. \`query\` is either \`select:name\` (several names comma-separated) for exact names, or keywords matched against tool names, descriptions and argument names; at most ${SEARCH_LIMIT} matches are loaded per search.`,
    input: ToolSearchInput,
    annotations: READ_ONLY,
    execute({ query }: z.output<typeof ToolSearchInput>): ToolResult {
      const { matches, unknown } = searchTools(query, searchable(host.tools()));
      if (matches.length > 0) host.append({ type: "tools.loaded", names: matches });
      const content: ToolContent[] = matches.map((name) => ({ type: "tool_reference", name }));
      if (unknown.length > 0) content.push({ type: "text", text: `Not in the deferred index: ${unknown.join(", ")}.` });
      if (content.length === 0)
        content.push({
          type: "text",
          text: `No deferred tool matches "${query}". Try other keywords, or \`select:<name>\` with a name from the index.`,
        });
      return { content };
    },
  });
}

const UseSkillInput = z.object({ name: z.string().check(z.minLength(1)) });

/** The `use_skill` built-in. It activates a Skill, bringing its instructions and Tools into context. */
export function useSkillTool(host: BuiltInHost): Tool<typeof UseSkillInput, undefined> {
  return Object.freeze({
    kind: "tool",
    name: "use_skill",
    description:
      "Activates one of the skills listed in your instructions: returns its full instructions and makes its tools available.",
    input: UseSkillInput,
    annotations: READ_ONLY,
    async execute({ name }: z.output<typeof UseSkillInput>): Promise<string | ToolResult> {
      const set = host.tools();
      const entry = set.skills.find((candidate) => candidate.skill.name === name && candidate.invokableBy !== "user");
      if (!entry) return { content: [{ type: "text", text: `No skill "${name}" is available.` }], isError: true };
      if (set.loaded.skills.has(name)) return `Skill "${name}" is already active.`;
      return activateSkill(entry.skill, host.fragmentContext(), host.append, "result");
    },
  });
}

/**
 * Renders a Skill's body, logs its Load point and returns the text the model reads. The text travels in
 * the Tool result when `use_skill` activated the Skill, and in the event itself for a User command.
 */
export async function activateSkill(
  skill: Skill,
  ctx: FragmentContext,
  append: BuiltInHost["append"],
  carrier: "result" | "event",
): Promise<string> {
  const body = (await skill.body.render(ctx, undefined)) ?? "";
  const names = skill.tools.map((tool) => tool.name);
  const available = names.length > 0 ? `\n\nTools now available: ${names.join(", ")}.` : "";
  const text = `Skill "${skill.name}" is active.\n\n${body}${available}`;
  append({
    type: "tools.loaded",
    names,
    skill: carrier === "event" ? { name: skill.name, body: text } : { name: skill.name },
  });
  return text;
}
