// The Worker's own bindings and secrets. karmi reads its bindings under these fixed names.
declare namespace Cloudflare {
  interface Env {
    KARMI_THREADS: DurableObjectNamespace;
    KARMI_SCOPES: DurableObjectNamespace;
    KARMI_MEMORY: DurableObjectNamespace;
    KARMI_KNOWLEDGE: DurableObjectNamespace;
    KARMI_MEDIA: R2Bucket;
    KARMI_QUEUE: Queue;
    /** The key ring every stored credential is encrypted with. Set it with `wrangler secret put KARMI_KEYRING`. */
    KARMI_KEYRING?: string;
    /** The bearer token the sample `authenticate` accepts. Set it with `wrangler secret put API_TOKEN`. */
    API_TOKEN?: string;
  }
}
