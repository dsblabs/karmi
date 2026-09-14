import type { Logger, MediaRef } from "./context";
import { errorMessage } from "./errors";
import { keys } from "./keys";
import type { OutputLimits } from "./spill";
import { truncateOutput } from "./spill";
import type { ToolResult } from "./tool";
import { parseForCodemode, stringifyForCodemode } from "./vendor/codemode/codec";

export const scriptValue = (result: Pick<ToolResult, "content" | "structuredContent">): unknown =>
  result.structuredContent !== undefined
    ? result.structuredContent
    : result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

/** Preserve structured results for __result without letting them bypass the Tool output ceiling. */
export async function storeStructuredResult(
  host: { scope: string; threadId: string; bucket: R2Bucket | undefined; signal: AbortSignal; logger: Logger },
  seq: number,
  result: ToolResult,
  limits: OutputLimits,
): Promise<{ structuredContent?: unknown; structuredOutput?: MediaRef }> {
  if (result.structuredContent === undefined) return {};
  const json = stringifyForCodemode(result.structuredContent);
  if (!truncateOutput(json, limits).truncated) return { structuredContent: JSON.parse(json) };
  if (!host.bucket) {
    host.logger.warn("Structured Tool output exceeded the limit without KARMI_MEDIA; the full value is lost.");
    return {};
  }
  const key = keys.structuredToolOutput(host.scope, host.threadId, seq);
  const bytes = new TextEncoder().encode(json);
  try {
    host.signal.throwIfAborted();
    await host.bucket.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
    if (host.signal.aborted) {
      await host.bucket.delete(key);
      host.signal.throwIfAborted();
    }
    return {
      structuredOutput: { id: `${seq}-structured`, key, mimeType: "application/json", bytes: bytes.byteLength },
    };
  } catch (error) {
    host.signal.throwIfAborted();
    host.logger.error("Spilling a structured Tool result failed; the full value is lost.", {
      error: errorMessage(error),
    });
    return {};
  }
}

export async function readScriptResult(
  bucket: R2Bucket | undefined,
  result: Pick<ToolResult, "content" | "structuredContent"> & { output?: MediaRef; structuredOutput?: MediaRef },
): Promise<unknown> {
  if (result.structuredContent !== undefined) return parseForCodemode(stringifyForCodemode(result.structuredContent));
  const ref = result.structuredOutput ?? result.output;
  if (!ref) return scriptValue(result);
  const object = await bucket?.get(ref.key);
  if (!object) throw new Error("The stored Tool result is no longer available.");
  const text = await object.text();
  return result.structuredOutput ? parseForCodemode(text) : text;
}
