import type { MediaRef } from "@karmi/core";
import { routeError } from "./route-error";

/**
 * Answers with the bytes of one media ref as a download. Returns a 404 answer when the bucket has no object with
 * the size and the type of the ref.
 */
export async function mediaDownload(bucket: R2Bucket, ref: MediaRef): Promise<Response> {
  const object = await bucket.get(ref.key);
  if (!object || object.size !== ref.bytes || object.httpMetadata?.contentType !== ref.mimeType) {
    await object?.body.cancel();
    return routeError(404, "http.notFound", "The media bytes are not available.");
  }
  const name = (ref.name ?? ref.id).replaceAll(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, "_");
  return new Response(object.body, {
    headers: {
      "content-type": ref.mimeType,
      "content-length": String(ref.bytes),
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
