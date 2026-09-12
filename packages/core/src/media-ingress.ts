import type { ContentBlock, ProviderCallOptions, ProviderEvent } from "./provider";
import { isMediaRef } from "./context";
import type { MediaWriter, MediaBody } from "./media";
import type { ToolContent, ToolOutputResult, ToolResult } from "./tool";

const unavailable: ContentBlock = { type: "text", text: "[media unavailable]" };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Native binary families are decoded here once, before anything can enter a persisted event. */
function binary(
  value: Record<string, unknown>,
): { data: string | Uint8Array | URL; mimeType: string; format: string } | undefined {
  if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string")
    return { data: value.data, mimeType: value.mimeType, format: "mcp" };
  if (
    (value.type === "image" || value.type === "document") &&
    record(value.source) &&
    value.source.type === "base64" &&
    typeof value.source.data === "string" &&
    typeof value.source.media_type === "string"
  )
    return { data: value.source.data, mimeType: value.source.media_type, format: "anthropic" };
  if (
    value.type === "file" &&
    typeof value.mediaType === "string" &&
    record(value.data) &&
    value.data.type === "data" &&
    (typeof value.data.data === "string" || value.data.data instanceof Uint8Array)
  )
    return { data: value.data.data, mimeType: value.mediaType, format: "sdk" };
  if (
    value.type === "file" &&
    typeof value.mediaType === "string" &&
    record(value.data) &&
    value.data.type === "url" &&
    value.data.url instanceof URL
  )
    return { data: value.data.url, mimeType: value.mediaType, format: "sdk" };
  return undefined;
}
interface IngressAccess {
  writer: MediaWriter | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
async function materialize(data: string | Uint8Array | URL, access: IngressAccess): Promise<MediaBody> {
  if (!(data instanceof URL)) return typeof data === "string" ? fromBase64(data) : data.slice().buffer;
  if (!access.fetch) throw new Error("No media download transport.");
  const response = await access.fetch(data, { signal: access.signal ?? null });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Media download failed.");
  }
  return response.body;
}
async function spill(value: unknown, access: IngressAccess): Promise<unknown> {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await spill(item, access));
    return result.some((item, i) => item !== value[i]) ? result : value;
  }
  if (!record(value)) return value;
  const image = binary(value);
  if (image) {
    try {
      if (!access.writer) return unavailable;
      const body = await materialize(image.data, access);
      const media = await access.writer.put(body, { mimeType: image.mimeType });
      const { type, data, source, mimeType, mediaType, ...native } = value;
      return { type: "media", media, format: image.format, ...(Object.keys(native).length && { native }) };
    } catch {
      return unavailable;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = await spill(entry, access);
  return Object.entries(out).some(([key, entry]) => entry !== value[key]) ? out : value;
}

export async function ingestProviderEvent(event: ProviderEvent, call: ProviderCallOptions): Promise<ProviderEvent> {
  if (event.type !== "part") return event;
  const block = event.block;
  if (block.type === "provider") {
    const raw = await spill(block.raw, { writer: call.media, fetch: call.fetch, signal: call.signal });
    if (record(raw) && raw.type === "media" && isMediaRef(raw.media))
      return { ...event, block: { type: "media", media: raw.media, ...mediaMetadata(block, raw) } };
    if (record(raw) && raw.type === "text" && typeof raw.text === "string")
      return { ...event, block: { type: "text", text: raw.text } };
    return { ...event, block: { ...block, raw } };
  }
  if (block.type === "server_tool" && block.result) {
    const raw = await spill(block.result.raw, { writer: call.media, fetch: call.fetch, signal: call.signal });
    // The native summary may itself contain base64; rebuild it from the sanitized result.
    return {
      ...event,
      block: {
        ...block,
        result: { raw, summary: raw === block.result.raw ? block.result.summary : JSON.stringify(raw) },
      },
    };
  }
  return event;
}

export async function ingestToolResult(result: ToolOutputResult, writer: MediaWriter): Promise<ToolResult> {
  const content: ToolContent[] = [];
  for (const block of result.content) {
    if (block.type !== "image") {
      content.push(block);
      continue;
    }
    const normalized = await spill(block, { writer });
    if (record(normalized) && normalized.type === "media" && isMediaRef(normalized.media))
      content.push({ type: "media", media: normalized.media });
    else content.push({ type: "text", text: "[media unavailable]" });
  }
  return { ...result, content };
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function mediaMetadata(
  block: ContentBlock,
  raw: Record<string, unknown>,
): { providerMetadata?: Record<string, Record<string, unknown>> } {
  const metadata = record(raw.native) && record(raw.native.providerMetadata) ? raw.native.providerMetadata : {};
  const providerMetadata: Record<string, Record<string, unknown>> = { ...block.providerMetadata };
  for (const [key, value] of Object.entries(metadata)) if (record(value)) providerMetadata[key] = value;
  return Object.keys(providerMetadata).length ? { providerMetadata } : {};
}
