import * as z from "zod/mini";
import type { FragmentContext } from "./fragment";
import { keys } from "./keys";
import type { Skill } from "./skill";
import { searchTools, SEARCH_LIMIT } from "./loading";
import {
  noteLine,
  notesEnabled,
  NOTE_MAX_CHARS,
  profileWriteIssues,
  RECALL_LIMIT,
  type MemoryConfig,
  type MemoryNote,
  type MemoryWrite,
} from "./memory";
import type { ThreadEventData } from "./thread-events";
import { errorResult, type Tool, type ToolContent, type ToolResult } from "./tool";
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

/** The Memory of one User, as the `remember` and `recall` built-ins reach it. */
export interface MemoryHost {
  /** The Agent's `memory` block from its Spec. */
  config: MemoryConfig;
  /** The agentId of the Agent the Thread runs. */
  agent: string;
  /** The Thread's User. Absent on a user-less Thread, where both Tools answer an error. */
  user: string | undefined;
  /** Writes to the User's Memory and records the User in the Scope's Memory index. */
  remember(write: MemoryWrite): Promise<void>;
  /** Searches the User's Notes. */
  recall(query: string): Promise<MemoryNote[]>;
}

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

const RememberInput = z.object({
  profile: z.optional(z.record(z.string(), z.unknown())),
  note: z.optional(z.string().check(z.minLength(1), z.maxLength(NOTE_MAX_CHARS))),
});
const RecallInput = z.object({ query: z.string().check(z.minLength(1)) });
const NO_USER = "This thread has no user, so there is no memory to use.";

/**
 * The `remember` and `recall` built-ins of an Agent with a `memory` block. `recall` is left out when the
 * Spec disables Notes. Both answer `isError` on a user-less Thread.
 */
export function memoryTools(host: MemoryHost): Tool[] {
  const tools: Tool[] = [rememberTool(host)];
  if (notesEnabled(host.config)) tools.push(recallTool(host));
  return tools;
}

function rememberTool(host: MemoryHost): Tool<typeof RememberInput, undefined> {
  const notes = notesEnabled(host.config);
  const fields = host.config.profile?.properties ?? {};
  const profileDoc =
    Object.keys(fields).length > 0
      ? ` \`profile\` sets fields of the user's profile, and a field set to null is cleared. The fields are ${JSON.stringify(fields)}.`
      : "";
  const noteDoc = notes ? " `note` adds one free-form fact to the user's notes." : "";
  return Object.freeze({
    kind: "tool",
    name: "remember",
    description: `Saves something about the user for every future conversation.${profileDoc}${noteDoc}`,
    input: RememberInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute({ profile, note }: z.output<typeof RememberInput>): Promise<string | ToolResult> {
      if (host.user === undefined) return errorResult(NO_USER);
      if (profile === undefined && note === undefined) return errorResult("Give a `profile`, a `note`, or both.");
      if (note !== undefined && !notes)
        return errorResult("Notes are disabled for this agent; write to `profile` instead.");
      const issues = profile ? profileWriteIssues(host.config.profile, profile) : [];
      if (issues.length > 0) return errorResult(issues.join(" "));
      await host.remember({ agent: host.agent, ...(profile && { profile }), ...(note !== undefined && { note }) });
      const done = [profile && "Profile updated", note !== undefined && "Note saved"].filter(Boolean);
      return `${done.join(". ")}.`;
    },
  });
}

function recallTool(host: MemoryHost): Tool<typeof RecallInput, undefined> {
  return Object.freeze({
    kind: "tool",
    name: "recall",
    description: `Searches the notes saved about the user by keyword and returns at most ${RECALL_LIMIT} of the best matches.`,
    input: RecallInput,
    annotations: READ_ONLY,
    async execute({ query }: z.output<typeof RecallInput>): Promise<string | ToolResult> {
      if (host.user === undefined) return errorResult(NO_USER);
      const notes = await host.recall(query);
      return notes.length === 0 ? `No notes match "${query}".` : notes.map(noteLine).join("\n");
    },
  });
}
