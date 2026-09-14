import type { MediaWriter } from "./media";
import type { Logger, MediaRef, ScopeId, ThreadRef, UserId } from "./context";
import type { Fragment } from "./fragment";
import { assertName } from "./names";
import type { Output, Schema } from "./schema";

/** The MCP tool annotations of a Tool. A hint the Tool does not set takes its value from `DEFAULT_ANNOTATIONS`. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** The annotation values a Tool gets for the hints it does not set. They are the MCP defaults. */
export const DEFAULT_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * A Connection resolved for a Tool call. A user-level grant (Scope, User, name) resolves before an
 * agent-level one (Scope, Agent, name).
 */
export interface Connection {
  name: string;
  type: string;
  /** The level the value was found at. */
  level: "agent" | "user";
  /** The credential value as stored. */
  value: unknown;
}

/** What a Tool's `execute` receives alongside its input. */
export interface ToolContext<Settings = undefined> {
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  /** The per-reference `settings` from the Agent Spec, validated against the Tool's schema. */
  settings: Settings;
  /** Present when the Tool `requires` a Connection and one resolved. */
  connection?: Connection;
  /** The recovery attempt of the enclosing Step, starting at 1. */
  attempt: number;
  /** The id of this call. It is stable across re-runs of the Step, so it serves upstream as an idempotency key. */
  callId: string;
  /** Stores bytes under the Thread and returns a `MediaRef` for them. */
  media: MediaWriter;
  logger: Logger;
  /** Aborted when the call must stop. */
  signal: AbortSignal;
}

/** One content block of a Tool result. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "media"; media: MediaRef }
  /** A block that loads the deferred Tool `name`. The Tool is in the model's context from this result on. */
  | { type: "tool_reference"; name: string };

/**
 * The result of one Tool call: content blocks plus an error flag. It uses the MCP result shape so an MCP
 * tool's result needs no conversion.
 */
export interface ToolResult {
  content: ToolContent[];
  /** True when the call failed and the content says why. */
  isError?: boolean;
  /** A structured value the Tool returned alongside its content. */
  structuredContent?: unknown;
}

/**
 * The outcome that hands a call to a Job. The Step parks until `thread.jobs` reports the Job's outcome under
 * this id.
 */
export interface ToolPending {
  pending: string;
}

/**
 * The result a Tool may return. Image blocks are stored as media at the boundary, so a `ToolResult` never
 * carries one.
 */
export interface ToolOutputResult extends Omit<ToolResult, "content"> {
  content: (ToolContent | { type: "image"; data: string; mimeType: string })[];
}

/** What a Tool's `execute` may return: plain text, a full result, or a pending Job. */
export type ToolOutcome = string | ToolOutputResult | ToolPending;

/** The definition `defineTool` takes. */
export interface ToolInput<In extends Schema, Settings extends Schema | undefined> {
  name: string;
  /** What the model reads to decide when to call the Tool. */
  description: string;
  /** The schema of the Tool's input. The Harness validates every call against it before `execute` runs. */
  input: In;
  /** Hints for the Policy and for scheduling calls. An unset hint takes its value from `DEFAULT_ANNOTATIONS`. */
  annotations?: Partial<ToolAnnotations>;
  /** The schema of the per-reference `settings` an Agent Spec may pass. */
  settings?: Settings;
  /** The name of the Connection this Tool acts through. */
  requires?: string;
  /** Usage instructions the Harness adds to the Prompt when the Tool is available. */
  instructions?: Fragment;
  /** A Spill limit for this Tool's output. It may only lower the Agent's `context.toolOutput`. */
  output?: { max: { maxChars?: number; maxLines?: number } };
  /** Runs one call. It returns text, a full result, or a pending Job. */
  execute: (input: Output<In>, ctx: ToolContext<Output<Settings>>) => ToolOutcome | Promise<ToolOutcome>;
}

/** A Tool as `defineTool` returns it: the definition with its annotations filled in, frozen. */
export interface Tool<In extends Schema = Schema, Settings extends Schema | undefined = Schema | undefined> {
  readonly kind: "tool";
  readonly name: string;
  readonly description: string;
  readonly input: In;
  readonly annotations: ToolAnnotations;
  readonly settings?: Settings;
  readonly requires?: string;
  readonly instructions?: Fragment;
  readonly output?: { max: { maxChars?: number; maxLines?: number } };
  readonly execute: (input: Output<In>, ctx: ToolContext<Output<Settings>>) => ToolOutcome | Promise<ToolOutcome>;
}

/** Defines a Tool for the Catalogue. Throws a `KarmiError` when the name is invalid or reserved. */
export function defineTool<In extends Schema, Settings extends Schema | undefined = undefined>(
  input: ToolInput<In, Settings>,
): Tool<In, Settings> {
  assertName("tool", input.name);
  return Object.freeze({
    kind: "tool",
    ...input,
    annotations: Object.freeze({ ...DEFAULT_ANNOTATIONS, ...input.annotations }),
  });
}
