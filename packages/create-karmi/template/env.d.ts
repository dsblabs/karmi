// The Worker's own bindings and secrets. karmi reads its bindings under these fixed names.
declare namespace Cloudflare {
  interface Env {
    KARMI_THREADS: DurableObjectNamespace;
    KARMI_SCOPES: DurableObjectNamespace;
    KARMI_MEMORY: DurableObjectNamespace;
    KARMI_KNOWLEDGE: DurableObjectNamespace;
    KARMI_MEDIA: R2Bucket;
    KARMI_QUEUE: Queue;
    /** The bearer token the sample `authenticate` accepts. Set it with `wrangler secret put API_TOKEN`. */
    API_TOKEN?: string;
  }
}
