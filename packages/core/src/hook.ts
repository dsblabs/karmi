import type { Logger, ScopeId, ThreadRef, UserId } from "./context.js";
import { assertName } from "./names.js";
import type { ToolAnnotations, ToolResult } from "./tool.js";
import type { CompactionTrigger, ThreadEventData, TurnInput } from "./thread-events.js";

export const HOOK_POINTS = [
  "before-turn",
  "after-turn",
  "before-tool",
  "after-tool",
  "before-compact",
  "after-compact",
  "on-error",
] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

/** Every Hook sees where it runs; nothing is ambient. */
export interface HookContextBase {
  point: HookPoint;
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  agent: string;
  turn: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface HookToolCall {
  /** The model's `tool_call` id. */
  id: string;
  /** `{threadId}:{seq}`, once the call is logged; absent at `before-tool`, which runs before the log entry. */
  callId?: string;
  name: string;
  input: unknown;
  annotations: ToolAnnotations;
}

/** A `before-tool` Hook may let the call through as is, rewrite its input, or refuse it. */
export type BeforeToolDecision = { effect: "allow"; input?: unknown } | { effect: "deny"; reason?: string };

export type TurnEnd = Extract<ThreadEventData, { type: "turn.completed" | "turn.failed" | "turn.paused" }>;
export type Compacted = Extract<ThreadEventData, { type: "thread.compacted" }>;

/** A `before-compact` Hook may let the Compaction run, call it off, or write the summary itself. */
export type BeforeCompactDecision = { skip: true } | { summary: string };

export interface HookContexts {
  "before-turn": HookContextBase & { input: TurnInput };
  "after-turn": HookContextBase & { end: TurnEnd };
  "before-tool": HookContextBase & { call: HookToolCall };
  "after-tool": HookContextBase & { call: HookToolCall; result: ToolResult & { interrupted?: { attempt: number } } };
  /** `instructions` come from `thread.compact({ instructions })`; `tokensBefore` is the context the trigger saw. */
  "before-compact": HookContextBase & { trigger: CompactionTrigger; instructions?: string; tokensBefore: number };
  "after-compact": HookContextBase & { compacted: Compacted };
  "on-error": HookContextBase & { error: { code: string; message: string } };
}

export interface HookResults {
  "before-turn": void;
  "after-turn": void;
  "before-tool": void | BeforeToolDecision;
  "after-tool": void;
  "before-compact": void | BeforeCompactDecision;
  "after-compact": void;
  "on-error": void;
}

export interface HookInput<P extends HookPoint> {
  name: string;
  point: P;
  description?: string;
  run(ctx: HookContexts[P]): HookResults[P] | Promise<HookResults[P]>;
}

export interface Hook<P extends HookPoint = HookPoint> {
  readonly kind: "hook";
  readonly name: string;
  readonly point: P;
  readonly description?: string;
  run(ctx: HookContexts[P]): HookResults[P] | Promise<HookResults[P]>;
}

export function defineHook<P extends HookPoint>(input: HookInput<P>): Hook<P> {
  assertName("hook", input.name);
  return Object.freeze({ kind: "hook", ...input });
}
