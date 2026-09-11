import { estimateTokens } from "./compaction";
import type { Message, ToolDefinition } from "./provider";
import { toJsonSchema } from "./schema";
import type { ThreadEventData } from "./thread-events";
import type { Tool } from "./tool";
import type { ContextConfig } from "./agent";

// Progressive disclosure, the pure part: which Tools the model starts a call with, which it has loaded
// since, and how `tool_search` finds one. A load point is a `tools.loaded` event; the loaded set is the
// union of them from the last Compaction on, so a Compaction that drops a load point unloads its Tools.

/** What the model has loaded in the context it currently sees: deferred Tools by name, and active Skills. */
export interface Loaded {
  tools: ReadonlySet<string>;
  skills: ReadonlySet<string>;
}

/** The most matches one search answers: enough to pick from, few enough to keep the load point small. */
export const SEARCH_LIMIT = 5;

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
 * Whether this Turn defers its deferrable Tools: all or nothing, so the model never sees half an index.
 * `auto` defers when the deferrable definitions would take at least `threshold` of the window.
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
 * `tool_search` over the deferred index: `select:a,b` names Tools outright; anything else is keywords
 * scored over each Tool's name, description and argument names, the best `SEARCH_LIMIT` returned.
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

// A term in the name weighs most, then an argument name, then the description; every term counts once.
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
