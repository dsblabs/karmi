// The bindings and the variables of the Worker. `pnpm setup` writes the variables to `.dev.vars`.
declare namespace Cloudflare {
  interface Env {
    KARMI_THREADS: DurableObjectNamespace;
    KARMI_SCOPES: DurableObjectNamespace;
    KARMI_MEMORY: DurableObjectNamespace;
    KARMI_KNOWLEDGE: DurableObjectNamespace;
    KARMI_MEDIA: R2Bucket;
    KARMI_QUEUE: Queue;
    /** The Worker Loader of isolate Scripts. A deployment without isolate Scripts has none. */
    KARMI_LOADER?: WorkerLoader;
    PLAYGROUND_DATA: DurableObjectNamespace<import("./src/sample-data").SampleDataDO>;
    /** The key ring that encrypts each stored credential. */
    KARMI_KEYRING?: string;
    /** The operator access token. */
    PLAYGROUND_TOKEN?: string;
    PLAYGROUND_PROVIDER?: string;
    PLAYGROUND_MODEL?: string;
    PLAYGROUND_BASE_URL?: string;
    /** The Provider credential. No route returns it. */
    PROVIDER_API_KEY?: string;
  }
}
