import { core, toJSONSchema } from "zod/mini";

/** Any zod v4 schema; core reads it through `zod/mini` so the developer may bring full `zod`. */
export type Schema = core.$ZodType;
export type Output<S extends Schema | undefined> = S extends Schema ? core.output<S> : undefined;
export type Input<S extends Schema> = core.input<S>;

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: Schema): JsonSchema {
  return toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as JsonSchema;
}
