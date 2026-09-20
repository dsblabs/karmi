declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "ThreadDO" | "ScopeConfigDO" | "MemoryDO" | "KnowledgeDO" | "SampleDataDO";
  }
}
