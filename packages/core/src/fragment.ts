import type { ScopeId, ThreadRef, UserId } from "./context";
import { assertName } from "./names";
import type { Output, Schema } from "./schema";

/** What a Fragment sees: the turn's context, never a template variable bag. */
export interface FragmentContext {
  model: string;
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  /** Names of the Tools available to the Agent this turn. */
  tools: readonly string[];
  now: Date;
}

export type FragmentRender<Args> = (
  ctx: FragmentContext,
  args: Args,
) => string | null | undefined | Promise<string | null | undefined>;

export interface FragmentInput<Args extends Schema | undefined> {
  name: string;
  description?: string;
  /** Schema for the `args` a Prompt entry may pass when referencing this Fragment. */
  args?: Args;
  render: FragmentRender<Output<Args>>;
}

export interface Fragment<Args extends Schema | undefined = Schema | undefined> {
  readonly kind: "fragment";
  readonly name: string;
  readonly description?: string;
  readonly args?: Args;
  readonly render: FragmentRender<Output<Args>>;
}

export function defineFragment<Args extends Schema | undefined = undefined>(
  input: FragmentInput<Args>,
): Fragment<Args> {
  assertName("fragment", input.name);
  return Object.freeze({ kind: "fragment", ...input });
}
