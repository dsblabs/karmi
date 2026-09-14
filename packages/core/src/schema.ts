import { core, toJSONSchema, unknown as anyValue } from "zod/mini";

/** Any zod v4 schema. Core reads it through `zod/mini`, so the developer may use the full `zod` package. */
export type Schema = core.$ZodType;
/** The output type of a Schema, or undefined when there is no Schema. */
export type Output<S extends Schema | undefined> = S extends Schema ? core.output<S> : undefined;

/** A JSON Schema document as a plain object. */
export type JsonSchema = Record<string, unknown>;

// A Tool whose input arrives as JSON Schema (an MCP tool) keeps that document verbatim. Providers see it
// unchanged, and the input is not validated here because the server that declared it does that.
const RAW = new WeakMap<Schema, JsonSchema>();

/**
 * Wraps a JSON Schema document as a Schema that accepts any value. `toJsonSchema` returns the document
 * unchanged.
 */
export function rawJsonSchema(schema: JsonSchema): Schema {
  const holder = anyValue();
  RAW.set(holder, schema);
  return holder;
}

/** The JSON Schema (draft 2020-12) of a Schema, or the verbatim document of one made by `rawJsonSchema`. */
export function toJsonSchema(schema: Schema): JsonSchema {
  return (
    RAW.get(schema) ??
    (toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as JsonSchema)
  );
}
