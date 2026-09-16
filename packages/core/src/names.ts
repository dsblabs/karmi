import { KarmiError, type KarmiErrorCode } from "./errors";

/** The kinds of item a Catalogue registers by name. */
export type CatalogueKind = "tool" | "fragment" | "skill" | "retriever" | "hook" | "deliverer";

const NAME = /^[a-z0-9_-]{1,64}$/;

/** The Tool names the Harness hands out itself. A Catalogue Tool may not use one of them. */
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "run_script",
  "read_output",
  "tool_search",
  "use_skill",
  "delegate",
  "schedule",
  "cancel_schedule",
  "list_schedules",
  "remember",
  "recall",
];

/** Throws a `KarmiError` when `name` is not a valid, unreserved Catalogue name for `kind`. */
export function assertName(kind: CatalogueKind, name: string): void {
  if (name.startsWith("__") || name.startsWith("mcp:")) {
    throw new KarmiError(
      "name.reserved",
      `${kind} name "${name}" is reserved: names may not start with "__" or "mcp:".`,
    );
  }
  if (!NAME.test(name)) {
    throw new KarmiError("name.invalid", `${kind} name "${name}" must match [a-z0-9_-]{1,64}.`);
  }
  if (kind === "tool" && (BUILT_IN_TOOL_NAMES.includes(name) || name.startsWith("search_"))) {
    throw new KarmiError("name.reserved", `tool name "${name}" is reserved for a built-in Tool.`);
  }
}

/** The pattern a caller-chosen identifier such as an agentId or a ScopeId must match. */
export const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Throws a `KarmiError` with `code` when `value` does not match `IDENTIFIER`. Identifiers allow more than
 * Catalogue names.
 */
export function assertIdentifier(code: KarmiErrorCode, label: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new KarmiError(code, `${label} "${value}" must match [A-Za-z0-9_-]{1,64}.`);
  }
}

/**
 * Freezes `value` and every object reachable from it, then returns it. A Turn's Agent Spec snapshot is frozen
 * this way.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The name pattern for Knowledge corpora, leaving room for the search Tool prefix. */
export const KNOWLEDGE_NAME = /^[A-Za-z0-9_-]{1,57}$/;
/** The explanation used when a Knowledge name is invalid. */
export const KNOWLEDGE_NAME_MESSAGE = "Knowledge names must match [A-Za-z0-9_-]{1,57}.";
