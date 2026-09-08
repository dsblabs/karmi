import type { Logger, MediaRef, ScopeId, ThreadRef, UserId } from "./context.js";
import type { Fragment } from "./fragment.js";
import { assertName } from "./names.js";
import type { Output, Schema } from "./schema.js";

/** MCP tool annotations with MCP's absent-defaults. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const DEFAULT_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** A resolved Connection value: user-level (Scope, User, name) wins over agent-level (Scope, Agent, name). */
export interface Connection {
  name: string;
  type: string;
  level: "agent" | "user";
  value: unknown;
}

export interface ToolContext<Settings = undefined> {
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  /** The per-reference `settings` from the Agent Spec, validated against the Tool's schema. */
  settings: Settings;
  /** Present when the Tool `requires` a Connection and one resolved. */
  connection?: Connection;
  /** Recovery attempt of the enclosing Step, starting at 1. */
  attempt: number;
  /** Stable across re-runs; pass it upstream as an idempotency key. */
  callId: string;
  media: { put(body: ReadableStream | ArrayBuffer | string, opts?: { mimeType?: string; name?: string }): Promise<MediaRef> };
  logger: Logger;
  signal: AbortSignal;
}

export type ToolContent = { type: "text"; text: string } | { type: "media"; media: MediaRef };

/** JSON-Schema-native so an MCP tool's result is the same shape. */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolInput<In extends Schema, Settings extends Schema | undefined> {
  name: string;
  description: string;
  input: In;
  annotations?: Partial<ToolAnnotations>;
  settings?: Settings;
  /** Name of the Connection this Tool acts through. */
  requires?: string;
  /** Usage instructions the Harness adds to the Prompt when the Tool is available. */
  instructions?: Fragment;
  /** Lower the Spill limit for this Tool's output below the Agent's `context.toolOutput`. */
  output?: { max: { maxChars?: number; maxLines?: number } };
  execute: (input: Output<In>, ctx: ToolContext<Output<Settings>>) => string | ToolResult | Promise<string | ToolResult>;
}

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
  readonly execute: (input: Output<In>, ctx: ToolContext<Output<Settings>>) => string | ToolResult | Promise<string | ToolResult>;
}

export function defineTool<In extends Schema, Settings extends Schema | undefined = undefined>(input: ToolInput<In, Settings>): Tool<In, Settings> {
  assertName("tool", input.name);
  return Object.freeze({ kind: "tool", ...input, annotations: Object.freeze({ ...DEFAULT_ANNOTATIONS, ...input.annotations }) });
}
