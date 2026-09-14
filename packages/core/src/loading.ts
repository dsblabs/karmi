import { estimateTokens } from "./compaction";
import type { Message, ToolDefinition } from "./provider";
import { toJsonSchema } from "./schema";
import type { ThreadEventData } from "./thread-events";
import type { Tool } from "./tool";
import type { ContextConfig } from "./agent";

// Progressive disclosure of Tools, without any I/O. This module decides which Tools the model starts a
// Turn with, which it has loaded since, and how `tool_search` finds one. A Load point is a `tools.loaded`
// event. The loaded set is the union of the Load points since the last Compaction, so a Compaction that
// drops a Load point unloads its Tools.

/** The deferred Tools and the active Skills the model's current context has loaded, by name. */
export interface Loaded {
  tools: ReadonlySet<string>;
  skills: ReadonlySet<string>;
}

/**
 * The most matches one `tool_search` returns. It keeps a Load point small while giving the model enough to
 * pick from.
 */
export const SEARCH_LIMIT = 5;

/** The loaded set that the `tools.loaded` events among `events` add up to. */
export function foldLoaded(events: Iterable<ThreadEventData>): Loaded {
  const tools = new Set<string>();
  const skills = new Set<string>();
  for (const event of events) {
    if (event.type !== "tools.loaded") continue;
    for (const name of event.names) tools.add(name);
    if (event.skill) skills.add(event.skill.name);
  }
  return { tools, skills };
}

/** The deferred Tools a transcript has loaded: every `tool_reference` a Tool result carries. */
export function loadedToolNames(messages: readonly Message[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    for (const block of message.content) if (block.type === "tool_reference") names.add(block.name);
  }
  return names;
}

/**
 * Whether this Turn defers its deferrable Tools. It is all or nothing, so the model never sees half an
 * index. `auto` defers when the deferrable definitions would take at least `threshold` of the window.
 */
export function deferAll(
  config: Required<NonNullable<ContextConfig["tools"]>>,
  deferrable: readonly ToolDefinition[],
  window: number,
): boolean {
  if (config.defer !== "auto") return config.defer === "always";
  if (deferrable.length === 0) return false;
  return estimateTokens(deferrable) >= config.threshold * window;
}

/**
 * Searches the deferred index for `tool_search`. A `select:a,b` query names Tools outright. Any other
 * query is keywords scored over each Tool's name, description and argument names, and the best
 * `SEARCH_LIMIT` matches are returned.
 */
export function searchTools(query: string, index: readonly Tool[]): { matches: string[]; unknown: string[] } {
  const trimmed = query.trim();
  if (trimmed.toLowerCase().startsWith("select:")) {
    const names = trimmed
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const known = new Set(index.map((tool) => tool.name));
    return {
      matches: names.filter((name) => known.has(name)),
      unknown: names.filter((name) => !known.has(name)),
    };
  }
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { matches: [], unknown: [] };
  const scored = index.flatMap((tool, position) => {
    const score = keywordScore(terms, tool);
    return score > 0 ? [{ name: tool.name, score, position }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  return { matches: scored.slice(0, SEARCH_LIMIT).map((entry) => entry.name), unknown: [] };
}

// A term in the name weighs most, then an argument name, then the description. Every term counts once.
function keywordScore(terms: readonly string[], tool: Tool): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const args = argumentNames(tool).join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    else if (args.includes(term)) score += 2;
    else if (description.includes(term)) score += 1;
  }
  return score;
}

function argumentNames(tool: Tool): string[] {
  const { properties } = toJsonSchema(tool.input);
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}
