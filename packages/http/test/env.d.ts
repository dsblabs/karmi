declare namespace Cloudflare {
  interface Env {
    KARMI_THREADS: DurableObjectNamespace;
    KARMI_SCOPES: DurableObjectNamespace;
    KARMI_MEDIA: R2Bucket;
    KARMI_QUEUE: Queue;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "ThreadDO" | "ScopeConfigDO";
  }
}

// Vite expands `import.meta.glob` at build time; this declares the one form the boundary test uses.
interface ImportMeta {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
}
