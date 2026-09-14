import type { Logger, ScopeId, ThreadRef, UserId } from "./context";
import { assertName } from "./names";
import type { ToolAnnotations, ToolResult } from "./tool";
import type { CompactionTrigger, ThreadEventData, TurnInput } from "./thread-events";

/** Every point in a Turn a Hook may attach to. */
export const HOOK_POINTS = [
  "before-turn",
  "after-turn",
  "before-tool",
  "after-tool",
  "before-compact",
  "after-compact",
  "on-error",
] as const;
/** One of `HOOK_POINTS`. */
export type HookPoint = (typeof HOOK_POINTS)[number];

/** The context every Hook receives. It carries the Scope, Thread and Turn the Hook runs in. */
export interface HookContextBase {
  point: HookPoint;
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  agent: string;
  turn: number;
  logger: Logger;
  /** Aborted when the Turn must stop. */
  signal: AbortSignal;
}

/** The tool call a `before-tool` or `after-tool` Hook sees. */
export interface HookToolCall {
  /** The model's `tool_call` id. */
  id: string;
  /**
   * The call's `{threadId}:{seq}` id once the call is logged. It is absent at `before-tool`, which runs first.
   */
  callId?: string;
  name: string;
  input: unknown;
  annotations: ToolAnnotations;
}

/** A `before-tool` Hook may let the call through as is, rewrite its input, or refuse it. */
export type BeforeToolDecision = { effect: "allow"; input?: unknown } | { effect: "deny"; reason?: string };

/** The Event that ended a Turn. */
export type TurnEnd = Extract<ThreadEventData, { type: "turn.completed" | "turn.failed" | "turn.paused" }>;
/** The `thread.compacted` Event a Compaction appended. */
export type Compacted = Extract<ThreadEventData, { type: "thread.compacted" }>;

/** A `before-compact` Hook may let the Compaction run, call it off, or write the summary itself. */
export type BeforeCompactDecision = { skip: true } | { summary: string };

/** The context a Hook receives at each point. */
export interface HookContexts {
  "before-turn": HookContextBase & { input: TurnInput };
  "after-turn": HookContextBase & { end: TurnEnd };
  "before-tool": HookContextBase & { call: HookToolCall };
  "after-tool": HookContextBase & { call: HookToolCall; result: ToolResult & { interrupted?: { attempt: number } } };
  /**
   * `instructions` comes from `thread.compact({ instructions })`. `tokensBefore` is the context size the
   * trigger saw.
   */
  "before-compact": HookContextBase & { trigger: CompactionTrigger; instructions?: string; tokensBefore: number };
  "after-compact": HookContextBase & { compacted: Compacted };
  "on-error": HookContextBase & { error: { code: string; message: string } };
}

/** What a Hook may return at each point. */
export interface HookResults {
  "before-turn": void;
  "after-turn": void;
  "before-tool": void | BeforeToolDecision;
  "after-tool": void;
  "before-compact": void | BeforeCompactDecision;
  "after-compact": void;
  "on-error": void;
}

/** The definition `defineHook` takes. */
export interface HookInput<P extends HookPoint> {
  name: string;
  point: P;
  description?: string;
  /** Runs when a Turn reaches the Hook's point. */
  run(ctx: HookContexts[P]): HookResults[P] | Promise<HookResults[P]>;
}

/** A Hook as `defineHook` returns it. */
export interface Hook<P extends HookPoint = HookPoint> {
  readonly kind: "hook";
  readonly name: string;
  readonly point: P;
  readonly description?: string;
  run(ctx: HookContexts[P]): HookResults[P] | Promise<HookResults[P]>;
}

/** Defines a Hook for the Catalogue. Throws a `KarmiError` when the name is invalid. */
export function defineHook<P extends HookPoint>(input: HookInput<P>): Hook<P> {
  assertName("hook", input.name);
  return Object.freeze({ kind: "hook", ...input });
}
