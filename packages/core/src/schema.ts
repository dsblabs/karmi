import { core, toJSONSchema, unknown as anyValue } from "zod/mini";

/** Any zod v4 schema; core reads it through `zod/mini` so the developer may bring full `zod`. */
export type Schema = core.$ZodType;
export type Output<S extends Schema | undefined> = S extends Schema ? core.output<S> : undefined;

export type JsonSchema = Record<string, unknown>;

// A Tool whose input arrives as JSON Schema (an MCP tool) keeps that document verbatim: providers see it
// unchanged, and the input is not validated here because the server that declared it does that.
const RAW = new WeakMap<Schema, JsonSchema>();

export function rawJsonSchema(schema: JsonSchema): Schema {
  const holder = anyValue();
  RAW.set(holder, schema);
  return holder;
}

export function toJsonSchema(schema: Schema): JsonSchema {
  return (
    RAW.get(schema) ??
    (toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as JsonSchema)
  );
}
