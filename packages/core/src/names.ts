import { KarmiError } from "./errors.js";

export type CatalogueKind = "tool" | "fragment" | "skill" | "retriever" | "hook" | "deliverer";

const NAME = /^[a-z0-9_-]{1,64}$/;

// Names the Harness hands out itself; a Catalogue Tool may not shadow them.
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "run_script",
  "read_output",
  "tool_search",
  "delegate",
  "schedule",
  "cancel_schedule",
  "list_schedules",
  "remember",
  "recall",
];

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
  if (kind === "tool" && BUILT_IN_TOOL_NAMES.includes(name)) {
    throw new KarmiError("name.reserved", `tool name "${name}" is reserved for a built-in Tool.`);
  }
}

export const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/** Caller-chosen identifiers (agentId, ScopeId) are wider than Catalogue names. */
export function assertIdentifier(code: string, label: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new KarmiError(code, `${label} "${value}" must match [A-Za-z0-9_-]{1,64}.`);
  }
}

// Agent Specs are plain data; freezing them all the way down keeps a Turn's snapshot honest.
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
