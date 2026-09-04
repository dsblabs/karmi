import type { Logger, ScopeId, ThreadRef, UserId } from "./context.js";
import { assertName } from "./names.js";

export const HOOK_POINTS = ["before-turn", "after-turn", "before-tool", "after-tool", "before-compact", "after-compact", "on-error"] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

export interface HookContext {
  point: HookPoint;
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  logger: Logger;
  signal: AbortSignal;
}

export interface HookInput {
  name: string;
  point: HookPoint;
  description?: string;
  run: (ctx: HookContext) => unknown;
}

export interface Hook extends Readonly<HookInput> {
  readonly kind: "hook";
}

export function defineHook(input: HookInput): Hook {
  assertName("hook", input.name);
  return Object.freeze({ kind: "hook", ...input });
}
