import type { JsonType, MemoryProfileProperty, MemoryProfileSchema } from "./agent";

// Memory is what Agents accumulate about a User across Threads. This module holds the pure logic: checking
// a Profile write against the Agent's schema, building a full-text query and rendering the Fragment. The
// storage is `memory-do.ts` and the Tools are in `builtins.ts`.

/** What Agents remember about one User in a Scope: the Profile fields and the Notes. */
export interface MemoryView {
  /** The Profile as stored: only fields some Agent has written. */
  profile: Record<string, unknown>;
  /** Notes, most recent first. */
  notes: MemoryNote[];
}

/** One free-form Note about a User. */
export interface MemoryNote {
  id: number;
  text: string;
  /** The Agent that wrote it. */
  agent: string;
  /** When it was written, as epoch milliseconds. */
  at: number;
}

/** What one `remember` call writes. A Profile field set to `null` is removed. */
export interface MemoryWrite {
  agent: string;
  profile?: Record<string, unknown>;
  note?: string;
}

/** How many of the most recent Notes the Memory Fragment shows. Older ones are reached through `recall`. */
export const MEMORY_FRAGMENT_NOTES = 20;
/** How many Notes `recall` returns when the call names no limit. */
export const RECALL_DEFAULT_LIMIT = 10;
/** The longest Note `remember` accepts, in characters. */
export const NOTE_MAX_CHARS = 2000;

/**
 * The reasons `fields` cannot be written to the Profile under `schema`, as sentences for the model. Empty
 * when the write is valid. Only the fields written are checked; a `null` value clears its field and is
 * always valid for a declared field.
 */
export function profileWriteIssues(schema: MemoryProfileSchema | undefined, fields: Record<string, unknown>): string[] {
  if (!schema) return Object.keys(fields).length > 0 ? ["This Agent declares no profile fields."] : [];
  const issues: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const property = schema.properties[field];
    if (!property) issues.push(`"${field}" is not a profile field of this Agent.`);
    else if (value !== null) check(property, value, field, issues);
  }
  return issues;
}

function check(property: MemoryProfileProperty, value: unknown, path: string, issues: string[]): void {
  const types = property.type === undefined ? [] : Array.isArray(property.type) ? property.type : [property.type];
  if (types.length > 0 && !types.some((type) => isType(type, value))) {
    issues.push(`"${path}" must be ${types.map(article).join(" or ")}.`);
    return;
  }
  if (property.enum && !property.enum.some((option) => same(option, value))) {
    issues.push(`"${path}" must be one of ${property.enum.map((option) => JSON.stringify(option)).join(", ")}.`);
    return;
  }
  if (property.const !== undefined && !same(property.const, value)) {
    issues.push(`"${path}" must be ${JSON.stringify(property.const)}.`);
    return;
  }
  if (typeof value === "number") {
    if (property.minimum !== undefined && value < property.minimum)
      issues.push(`"${path}" must be at least ${property.minimum}.`);
    if (property.maximum !== undefined && value > property.maximum)
      issues.push(`"${path}" must be at most ${property.maximum}.`);
  } else if (typeof value === "string") {
    if (property.minLength !== undefined && value.length < property.minLength)
      issues.push(`"${path}" must be at least ${property.minLength} characters.`);
    if (property.maxLength !== undefined && value.length > property.maxLength)
      issues.push(`"${path}" must be at most ${property.maxLength} characters.`);
    if (property.pattern !== undefined && !new RegExp(property.pattern, "u").test(value))
      issues.push(`"${path}" must match /${property.pattern}/.`);
  } else if (Array.isArray(value)) {
    const items = property.items;
    if (items) value.forEach((item, i) => check(items, item, `${path}[${i}]`, issues));
  } else if (isRecord(value)) {
    for (const key of property.required ?? [])
      if (value[key] === undefined) issues.push(`"${path}.${key}" is required.`);
    for (const [key, nested] of Object.entries(property.properties ?? {}))
      if (value[key] !== undefined) check(nested, value[key], `${path}.${key}`, issues);
  }
}

function isType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
  }
}

function article(type: JsonType): string {
  return type === "null"
    ? "null"
    : type === "integer" || type === "array" || type === "object"
      ? `an ${type}`
      : `a ${type}`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The FTS5 match expression for a free-text `query`: every whitespace-separated term quoted and joined
 * with OR, so punctuation and FTS keywords are searched for rather than parsed. Undefined for a blank
 * query.
 */
export function ftsQuery(query: string): string | undefined {
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** The Memory Fragment for one Turn: the Profile and, when `notes` is on, the most recent Notes. */
export function renderMemory(view: MemoryView, notes: boolean): string {
  const lines = [
    "# Memory",
    notes
      ? "What is known about this user from earlier conversations. Update the profile or add a note with `remember`; search older notes with `recall`."
      : "What is known about this user from earlier conversations. Update the profile with `remember`.",
  ];
  const fields = Object.entries(view.profile);
  const recent = notes ? view.notes.slice(0, MEMORY_FRAGMENT_NOTES) : [];
  if (fields.length === 0 && recent.length === 0) {
    lines.push("", "Nothing is known about this user yet.");
    return lines.join("\n");
  }
  if (fields.length > 0)
    lines.push("", "## Profile", ...fields.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`));
  if (recent.length > 0)
    lines.push(
      "",
      "## Recent notes",
      ...recent.map((note) => `- ${new Date(note.at).toISOString().slice(0, 10)}: ${note.text}`),
    );
  return lines.join("\n");
}
