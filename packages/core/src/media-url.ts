import { mediaKeyScope } from "./keys";
import { AwsClient } from "aws4fetch";
import type { MediaRef } from "./context";
import { KarmiError } from "./errors";

/**
 * The R2 S3 credentials that sign media URLs. They are Deployment secrets and never part of Scope
 * config or stored refs.
 */
export interface MediaUrlOptions {
  /** The Cloudflare account id. */
  accountId: string;
  /** The R2 bucket name. */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
/**
 * The `karmi.media.url` API, which returns a presigned GET URL for a MediaRef that expires after
 * `ttl` seconds (1 to 604800). Without `options` every call throws `bindings.missing`.
 */
export function mediaUrls(options?: MediaUrlOptions) {
  const signer = options && new AwsClient({ ...options, service: "s3", region: "auto" });
  return {
    async url(ref: MediaRef, { ttl }: { ttl: number }): Promise<string> {
      if (!options || !signer)
        throw new KarmiError(
          "bindings.missing",
          "karmi.media.url requires createKarmi({ media: { accountId, bucket, accessKeyId, secretAccessKey } }).",
        );
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800)
        throw new KarmiError("media.urlInvalid", "Media URL ttl must be 1–604800 seconds.");
      if (!mediaKeyScope(ref.key)) throw new KarmiError("media.urlInvalid", "Invalid media key.");
      const url = new URL(
        `https://${options.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(options.bucket)}/${ref.key.split("/").map(encodeURIComponent).join("/")}`,
      );
      url.searchParams.set("X-Amz-Expires", String(ttl));
      return (await signer.sign(url, { method: "GET", aws: { signQuery: true } })).url;
    },
  };
}
