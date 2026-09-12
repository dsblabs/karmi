import { isMediaRef } from "./context";
import type { MediaRef } from "./context";
import type { ModelCapabilities, ProviderCallOptions, ProviderRequest } from "./provider";

export type EncodedMedia = { type: "text"; text: string } | { type: "inline"; data: string; media: MediaRef };
export type RequestMedia = ReadonlyMap<MediaRef, EncodedMedia>;
export function mediaKind(mime: string): "image" | "audio" | "video" | "pdf" | "file" {
  if (mime === "application/pdf") return "pdf";
  const kind = mime.split("/")[0];
  return kind === "image" || kind === "audio" || kind === "video" ? kind : "file";
}
export function filePlaceholder(ref: MediaRef): { type: "text"; text: string } {
  return { type: "text", text: `[file: ${ref.name ?? ref.id}, ${ref.mimeType}, ${ref.bytes} bytes — not viewable]` };
}
export function mediaPlaceholder(ref: MediaRef): EncodedMedia {
  return mediaKind(ref.mimeType) === "file" ? filePlaceholder(ref) : { type: "text", text: "[media unavailable]" };
}

/** Bytes exist only in the adapter's request-local map, never in the transcript. */
export async function prepareMedia(
  request: ProviderRequest,
  call: ProviderCallOptions,
  capabilities: ModelCapabilities,
): Promise<RequestMedia> {
  const media = new Map<MediaRef, EncodedMedia>();
  const cache = new Map<string, EncodedMedia>();
  for (const ref of references(request.messages)) {
    const identity = JSON.stringify(ref);
    const encoded = cache.get(identity) ?? (await encode(ref, call, capabilities));
    cache.set(identity, encoded);
    media.set(ref, encoded);
  }
  return media;
}
async function encode(
  ref: MediaRef,
  call: ProviderCallOptions,
  capabilities: ModelCapabilities,
): Promise<EncodedMedia> {
  const kind = mediaKind(ref.mimeType);
  if (kind === "file") return mediaPlaceholder(ref);
  const reason =
    capabilities[kind] === false
      ? "unsupported by model"
      : ref.bytes > (capabilities.maxMediaBytes ?? Infinity)
        ? "exceeds model size limit"
        : undefined;
  if (reason) return { type: "text", text: `[${kind} dropped: ${ref.name ?? ref.id} — ${reason}]` };
  try {
    const bytes = await call.media?.get(ref);
    if (!bytes || bytes.byteLength !== ref.bytes) return mediaPlaceholder(ref);
    return { type: "inline", data: toBase64(new Uint8Array(bytes)), media: ref };
  } catch {
    return mediaPlaceholder(ref);
  }
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function* references(value: unknown): Generator<MediaRef> {
  if (Array.isArray(value)) {
    for (const entry of value) yield* references(entry);
  } else if (value && typeof value === "object") {
    if ("type" in value && value.type === "media" && "media" in value && isMediaRef(value.media)) yield value.media;
    else for (const entry of Object.values(value)) yield* references(entry);
  }
}

/** Restores native binary blocks embedded in provider-owned Tool/MCP results. */
export function hydrateMedia(value: unknown, media: RequestMedia): unknown {
  if (Array.isArray(value)) return value.map((entry) => hydrateMedia(entry, media));
  if (!value || typeof value !== "object") return value;
  if ("type" in value && value.type === "media" && "media" in value && isMediaRef(value.media)) {
    const encoded = media.get(value.media) ?? mediaPlaceholder(value.media);
    if (encoded.type === "text") return encoded;
    const { mimeType } = value.media;
    const native = "native" in value && value.native && typeof value.native === "object" ? value.native : {};
    if ("format" in value && value.format === "mcp") return { ...native, type: "image", mimeType, data: encoded.data };
    if ("format" in value && value.format === "sdk")
      return { ...native, type: "file", mediaType: mimeType, data: { type: "data", data: encoded.data } };
    return {
      ...native,
      type: mimeType === "application/pdf" ? "document" : "image",
      source: { type: "base64", media_type: mimeType, data: encoded.data },
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hydrateMedia(entry, media)]));
}
