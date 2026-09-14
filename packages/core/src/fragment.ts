import type { ScopeId, ThreadRef, UserId } from "./context";
import { assertName } from "./names";
import type { Output, Schema } from "./schema";

/** The Turn context a Fragment renders from. It is not a bag of template variables. */
export interface FragmentContext {
  /** The id of the model in use this Turn. */
  model: string;
  scope: ScopeId;
  user?: UserId;
  thread: ThreadRef;
  /** Names of the Tools available to the Agent this turn. */
  tools: readonly string[];
  now: Date;
}

/** Renders a Fragment's text. Nothing is added to the Prompt when it returns null or undefined. */
export type FragmentRender<Args> = (
  ctx: FragmentContext,
  args: Args,
) => string | null | undefined | Promise<string | null | undefined>;

/** The definition `defineFragment` takes. */
export interface FragmentInput<Args extends Schema | undefined> {
  name: string;
  description?: string;
  /** Schema for the `args` a Prompt entry may pass when referencing this Fragment. */
  args?: Args;
  render: FragmentRender<Output<Args>>;
}

/** A Fragment as `defineFragment` returns it. */
export interface Fragment<Args extends Schema | undefined = Schema | undefined> {
  readonly kind: "fragment";
  readonly name: string;
  readonly description?: string;
  readonly args?: Args;
  readonly render: FragmentRender<Output<Args>>;
}

/** Defines a Fragment for the Catalogue. Throws a `KarmiError` when the name is invalid. */
export function defineFragment<Args extends Schema | undefined = undefined>(
  input: FragmentInput<Args>,
): Fragment<Args> {
  assertName("fragment", input.name);
  return Object.freeze({ kind: "fragment", ...input });
}
