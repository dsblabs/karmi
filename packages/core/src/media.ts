import { fileTypeFromBuffer } from "file-type";
import { ulid } from "ulid";
import type { MediaRef } from "./context";
import { KarmiError } from "./errors";
import { keys, mediaKeyScope } from "./keys";
import type { ScopeConfigDocument } from "./scope-config";

export type MediaBody = ReadableStream<Uint8Array> | ArrayBuffer | string;
export interface MediaOptions {
  mimeType?: string;
  name?: string;
}
export interface MediaWriter {
  put(body: MediaBody, options?: MediaOptions): Promise<MediaRef>;
}
export const DEFAULT_MEDIA_BYTES = 100 * 1024 * 1024;
const PART_BYTES = 5 * 1024 * 1024;

interface MediaOwner {
  bucket: R2Bucket | undefined;
  scope: string;
  threadId: string;
  limits?: ScopeConfigDocument["media"];
  signal?: AbortSignal;
}

/** One bounded buffer serves sniffing and multipart writes, regardless of input chunk sizes. */
export async function putMedia(
  { bucket, scope, threadId, limits = {}, signal }: MediaOwner,
  body: MediaBody,
  options: MediaOptions = {},
): Promise<MediaRef> {
  if (!bucket) throw new KarmiError("bindings.missing", "Media requires KARMI_MEDIA.");
  const id = ulid();
  const key = keys.media(scope, threadId, id);
  const reader = toStream(body).getReader();
  let buffer = new Uint8Array(Math.min(64 * 1024, limits.maxBytes ?? DEFAULT_MEDIA_BYTES));
  let filled = 0;
  let bytes = 0;
  let mimeType = "";
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  const flush = async (last: boolean) => {
    if (!mimeType) mimeType = await sniff(buffer.subarray(0, filled), options.mimeType);
    assertMediaType(mimeType, limits.allowedTypes);
    if (last && !upload) {
      await bucket.put(key, buffer.slice(0, filled), { httpMetadata: { contentType: mimeType } });
    } else {
      upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mimeType } });
      if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, filled)));
      if (last) await upload.complete(parts);
    }
    filled = 0;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      assertMediaSize(bytes, limits.maxBytes);
      for (let offset = 0; offset < next.value.length;) {
        if (filled === buffer.length && filled < PART_BYTES) buffer = grow(buffer);
        const count = Math.min(buffer.length - filled, next.value.length - offset);
        buffer.set(next.value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === PART_BYTES) await flush(false);
      }
    }
    signal?.throwIfAborted();
    await flush(true);
    if (signal?.aborted) {
      await bucket.delete(key);
      signal.throwIfAborted();
    }
    return { id, key, mimeType, bytes, ...(options.name !== undefined && { name: options.name }) };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await upload?.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function toStream(body: MediaBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
async function sniff(bytes: Uint8Array, claim?: string): Promise<string> {
  try {
    const type = await fileTypeFromBuffer(bytes);
    if (type) return type.mime;
  } catch {
    /* A short header can still use the caller's claim. */
  }
  return claim?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}
export function matchesType(pattern: string, mime: string): boolean {
  return pattern === mime || pattern === "*/*" || pattern === `${mime.split("/")[0]}/*`;
}

/** Scope checks precede all reads; a ref from a fork may point to another Thread in this Scope. */
export function mediaAccess(bucket: R2Bucket | undefined, scope: string, writer: MediaWriter) {
  return {
    ...writer,
    async get(ref: MediaRef): Promise<ArrayBuffer | undefined> {
      if (!bucket || mediaKeyScope(ref.key) !== scope) return undefined;
      const object = await bucket.get(ref.key);
      if (!object) return undefined;
      if (object.size !== ref.bytes || object.httpMetadata?.contentType !== ref.mimeType) {
        await object.body.cancel();
        return undefined;
      }
      return object.arrayBuffer();
    },
  };
}

function assertMediaType(mimeType: string, allowedTypes?: string[]): void {
  if (allowedTypes && !allowedTypes.some((type) => matchesType(type, mimeType)))
    throw new KarmiError("media.typeDenied", `Media type ${mimeType} is not allowed.`);
}
function assertMediaSize(bytes: number, maxBytes = DEFAULT_MEDIA_BYTES): void {
  if (bytes > maxBytes) throw new KarmiError("media.tooLarge", "Media exceeds the maximum upload size.");
}

function grow(buffer: Uint8Array): Uint8Array<ArrayBuffer> {
  const larger = new Uint8Array(Math.min(buffer.length * 2, PART_BYTES));
  larger.set(buffer);
  return larger;
}
