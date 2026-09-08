import * as z from "zod/mini";
import { keys } from "./keys.js";
import type { Tool, ToolResult } from "./tool.js";

// Framework built-in Tools: the same shape as a Catalogue Tool, minted by the Harness rather than a
// developer, so they bypass the name check that reserves their names.

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const ReadOutputInput = z.object({
  ref: z.string().check(z.regex(/^\d+$/, "a ref is the id named in a truncation marker")),
  offset: z.optional(z.int().check(z.nonnegative())),
  limit: z.optional(z.int().check(z.positive())),
});

/** `read_output(ref, range)`: re-reads a spilled Tool result of this Thread by the ref its marker names. */
export function readOutputTool(bucket: R2Bucket | undefined, scope: string, threadId: string): Tool<typeof ReadOutputInput, undefined> {
  return Object.freeze({
    kind: "tool",
    name: "read_output",
    description: "Reads the full output of an earlier tool result that was truncated. `ref` is the id named in the truncation marker; `offset` and `limit` select lines (0-based).",
    input: ReadOutputInput,
    annotations: READ_ONLY,
    async execute({ ref, offset = 0, limit }: z.output<typeof ReadOutputInput>): Promise<string | ToolResult> {
      const object = bucket ? await bucket.get(keys.toolOutput(scope, threadId, Number(ref))) : null;
      if (!object) return { content: [{ type: "text", text: `No stored output "${ref}" on this Thread.` }], isError: true };
      const lines = (await object.text()).split("\n");
      const page = lines.slice(offset, limit === undefined ? undefined : offset + limit);
      return page.length > 0 ? page.join("\n") : `Output "${ref}" has ${lines.length} lines; nothing at offset ${offset}.`;
    },
  });
}
