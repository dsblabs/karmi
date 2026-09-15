declare namespace Cloudflare {
  interface Env {
    KARMI_THREADS: DurableObjectNamespace;
    KARMI_SCOPES: DurableObjectNamespace;
    KARMI_MEMORY: DurableObjectNamespace;
    KARMI_MEDIA: R2Bucket;
    KARMI_QUEUE: Queue;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "ThreadDO" | "ScopeConfigDO" | "MemoryDO";
  }
}
