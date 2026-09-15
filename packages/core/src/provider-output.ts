import type { ContentBlock } from "./provider";
import { isMediaRef, type MediaRef } from "./context";
import { keys } from "./keys";
import { truncateOutput, type OutputLimits } from "./spill";

/** A native payload ready for an event, with bytes to store when the payload exceeds its limits. */
export function providerOutput(
  raw: unknown,
  limits: OutputLimits,
  scope: string,
  thread: string,
  seq: number,
): { raw: unknown; bytes?: Uint8Array } {
  const text = JSON.stringify(raw) ?? "null";
  if (!truncateOutput(text, limits).truncated) return { raw };
  const bytes = new TextEncoder().encode(text);
  return {
    raw: {
      id: String(seq),
      key: keys.toolOutput(scope, thread, seq),
      mimeType: "application/json",
      bytes: bytes.byteLength,
    },
    bytes,
  };
}

/** Restores spilled native call and result payloads, or uses the summary when stored bytes are missing. */
export async function restoreProviderTool(
  block: Extract<ContentBlock, { type: "server_tool" }>,
  get: (ref: MediaRef) => Promise<ArrayBuffer | undefined>,
): Promise<ContentBlock> {
  const raw = await readRaw(block.raw, get);
  const result = await readRaw(block.result?.raw, get);
  if (!raw.ok || !result.ok) return { type: "text", text: block.result?.summary ?? `Called ${block.name}.` };
  return {
    ...block,
    ...(block.raw !== undefined && { raw: raw.value }),
    input: isMediaRef(block.input) ? callInput(raw.value) : block.input,
    ...(block.result && { result: { ...block.result, raw: result.value } }),
  };
}

async function readRaw(
  raw: unknown,
  get: (ref: MediaRef) => Promise<ArrayBuffer | undefined>,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!isMediaRef(raw)) return { ok: true, value: raw };
  const bytes = await get(raw);
  return bytes ? { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) } : { ok: false };
}

function callInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("input" in raw)) return {};
  return "type" in raw && raw.type === "tool-call" && typeof raw.input === "string" ? JSON.parse(raw.input) : raw.input;
}
