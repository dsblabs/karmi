import type { ToolOutputResult } from "@karmi/core";

/** Makes a Tool result that tells the model about a failure. */
export const errorResult = (text: string): ToolOutputResult => ({ content: [{ type: "text", text }], isError: true });
