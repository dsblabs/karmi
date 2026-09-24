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
    /** The container sandbox of container Scripts. It works only when `PLAYGROUND_CONTAINERS` is set. */
    KARMI_SANDBOX?: DurableObjectNamespace<import("@karmi/core").KarmiSandbox>;
    /**
     * Where container Scripts run: `docker` for `pnpm dev:containers`, `cloudflare` for a deployment that selected
     * them. Without it, the Worker offers no container Scripts.
     */
    PLAYGROUND_CONTAINERS?: string;
    /** Workers AI, which embeds the guides of the vector retrieval scenario. `pnpm deploy` adds it with the index. */
    KARMI_AI?: Ai;
    /** The Vectorize index of the vector retrieval scenario. `pnpm deploy` adds it when you select vector retrieval. */
    KNOWLEDGE_VECTORS?: Vectorize;
    PLAYGROUND_DATA: DurableObjectNamespace<import("./src/sample-data").SampleDataDO>;
    /** The key ring that encrypts each stored credential. */
    KARMI_KEYRING?: string;
    /** The operator access token. */
    PLAYGROUND_TOKEN?: string;
    PLAYGROUND_PROVIDER?: string;
    PLAYGROUND_MODEL?: string;
    PLAYGROUND_BASE_URL?: string;
    /**
     * The public https origin of the Playground, for example `https://karmi-playground-a1b2.example.workers.dev`.
     * The OAuth Connections of the MCP scenario need it. `pnpm deploy` sets it.
     */
    PLAYGROUND_ORIGIN?: string;
    /** The Provider credential. No route returns it. */
    PROVIDER_API_KEY?: string;
    /** The id of the optional second Provider of the Provider scenario. `pnpm setup` asks for it. */
    PLAYGROUND_SECOND_PROVIDER?: string;
    /** The model of the second Provider. */
    PLAYGROUND_SECOND_MODEL?: string;
    /** The endpoint of the second Provider when it is a custom endpoint. */
    PLAYGROUND_SECOND_BASE_URL?: string;
    /** The credential of the second Provider. No route returns it. */
    SECOND_PROVIDER_API_KEY?: string;
    /** The Cloudflare account of the optional AI Gateway that the operator supplied. */
    PLAYGROUND_GATEWAY_ACCOUNT?: string;
    /** The id of the AI Gateway. */
    PLAYGROUND_GATEWAY_ID?: string;
    /** The token of an authenticated AI Gateway. No route returns it. */
    GATEWAY_TOKEN?: string;
  }
}
