import { defineFragment, type Fragment, type FragmentRender } from "./fragment.js";
import { assertName } from "./names.js";
import type { Schema } from "./schema.js";
import type { Tool } from "./tool.js";

export interface SkillInput<Settings extends Schema | undefined> {
  name: string;
  /** Always in the model's context; the body is not. */
  description: string;
  /** Enters context only when the Skill is invoked. */
  body: Fragment | FragmentRender<undefined>;
  /** Exist only while the Skill is active. */
  tools?: Tool[];
  settings?: Settings;
}

export interface Skill<Settings extends Schema | undefined = Schema | undefined> {
  readonly kind: "skill";
  readonly name: string;
  readonly description: string;
  readonly body: Fragment;
  readonly tools: readonly Tool[];
  readonly settings?: Settings;
}

export function defineSkill<Settings extends Schema | undefined = undefined>(
  input: SkillInput<Settings>,
): Skill<Settings> {
  assertName("skill", input.name);
  const body = typeof input.body === "function" ? defineFragment({ name: input.name, render: input.body }) : input.body;
  return Object.freeze({ kind: "skill", ...input, body, tools: Object.freeze([...(input.tools ?? [])]) });
}
