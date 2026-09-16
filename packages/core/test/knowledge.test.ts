import { describe, expect, it } from "vitest";
import { clock, karmi, provider, scope } from "./worker";
import { KNOWLEDGE_INLINE_LIMIT } from "../src/index";
import { reply } from "../src/testing/index";

const message = { kind: "message" as const, parts: [{ type: "text" as const, text: "Find our refund policy" }] };

describe("Knowledge", () => {
  it("replaces documents, ranks passages, and isolates corpora by Scope", async () => {
    const corpus = scope.knowledge("ranking");
    const docs = [
      { id: "brief", text: "Refund policy: refund refund refund.", metadata: { source: "handbook" } },
      { id: "long", text: "Refund details include many other terms about shipping accounts and support hours." },
      { id: "other", text: "Pineapple pizza." },
    ];
    expect(await corpus.ingest(docs)).toEqual({ indexed: 3 });
    await corpus.ingest(docs);
    const hits = await corpus.search("refund");
    expect(hits.map((hit) => hit.docId)).toEqual(["brief", "long"]);
    expect(hits[0]).toMatchObject({ seq: 0, metadata: { source: "handbook" } });
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(await karmi.scope("another").knowledge("ranking").search("refund")).toEqual([]);
    await corpus.ingest([{ id: "brief", text: "Exchanges only." }]);
    expect((await corpus.search("refund")).map((hit) => hit.docId)).toEqual(["long"]);
    await corpus.delete(["long"]);
    await corpus.delete(["long"]);
    expect(await corpus.search("refund")).toEqual([]);
    expect(await scope.knowledge.list()).toContain("ranking");
    await corpus.destroy();
    await corpus.destroy();
    expect(await corpus.search("exchanges")).toEqual([]);
    expect(await scope.knowledge.list()).not.toContain("ranking");
  });
  it("fixes chunking, preserves Unicode, and renders inline documents without overlap", async () => {
    const corpus = scope.knowledge("chunks");
    await corpus.ingest([{ id: "one", text: "alpha beta gamma delta" }], { index: { chunkSize: 10, overlap: 4 } });
    expect((await corpus.search("alpha")).map((hit) => hit.text)).toEqual(["alpha beta"]);
    expect((await corpus.search("gamma")).map((hit) => hit.seq)).toEqual([1]);
    expect(await corpus.inline()).toBe("alpha beta gamma delta");
    await expect(
      corpus.ingest([{ id: "two", text: "hello" }], { index: { chunkSize: 12, overlap: 0 } }),
    ).rejects.toMatchObject({ code: "knowledge.indexConflict" });
    await corpus.destroy();
    await corpus.ingest([{ id: "unicode", text: "😀 alpha 😀 beta" }], { index: { chunkSize: 7, overlap: 0 } });
    expect((await corpus.search("alpha"))[0]?.text).toBe("😀 alpha");
  });

  it("offers a read-only search Tool and respects explicit Policy denial", async () => {
    await scope.knowledge("faq").ingest([{ id: "refunds", text: "Refunds within thirty days." }]);
    const spec = {
      agentId: "knowledge-search",
      name: "Support",
      instructions: [],
      model: { id: "test/model" },
      knowledge: [{ name: "faq", mode: "search" as const }],
      context: { tools: { defer: "always" as const } },
    };
    await scope.agents.put(spec);
    provider.script([[reply.toolCall("search_faq", { query: "refunds" }, "lookup")], "Thirty days."]);
    const events = await scope.thread({ agent: spec.agentId, threadId: "knowledge-search" }).send(message);
    const tool = provider.requests[0]?.tools?.find((tool) => tool.name === "search_faq");
    expect(tool?.deferred).not.toBe(true);
    expect(events).toContainEvent({ type: "tool.result", id: "lookup", isError: false });
    const result = events.find((event) => event.type === "tool.result" && event.id === "lookup");
    expect(JSON.stringify(result)).toContain("Refunds within thirty days.");
    await scope.agents.put({ ...spec, policy: [{ match: { tool: "search_faq" }, effect: "deny" }] });
    provider.script([[reply.toolCall("search_faq", { query: "refunds" }, "blocked")], "No access."]);
    const denied = await scope.thread({ agent: spec.agentId, threadId: "knowledge-denied" }).send(message);
    expect(provider.requests[0]?.tools?.some((tool) => tool.name === "search_faq")).toBe(false);
    expect(denied).toContainEvent({ type: "tool.result", id: "blocked", isError: true });
  });

  it("fails a Turn before the model sees an oversized inline corpus", async () => {
    const corpus = scope.knowledge("inline");
    await corpus.ingest([{ id: "policy", text: "A short policy." }]);
    await scope.agents.put({
      agentId: "knowledge-inline",
      name: "Inline",
      instructions: [],
      model: { id: "test/model" },
      knowledge: [{ name: "inline", mode: "inline" }],
    });
    provider.script(["Understood"]);
    await scope.thread({ agent: "knowledge-inline", threadId: "inline-small" }).send(message);
    expect(provider.requests[0]?.system).toContain("# Knowledge: inline\nA short policy.");
    expect(provider.requests[0]?.tools?.some((tool) => tool.name === "search_inline")).not.toBe(true);
    await corpus.ingest([{ id: "policy", text: "x".repeat(KNOWLEDGE_INLINE_LIMIT + 1) }]);
    provider.script(["Must not run"]);
    const failed = await scope.thread({ agent: "knowledge-inline", threadId: "inline-large" }).send(message);
    expect(failed.find((event) => event.type === "turn.failed")).toMatchObject({
      message: expect.stringContaining("inline limit is 32000"),
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("resumes bulk ingest from its checkpoint after a Retriever failure", async () => {
    const corpus = scope.knowledge("bulk");
    const docs = Array.from({ length: 40 }, (_, i) => ({ id: `doc${i}`, text: `Passage ${i}` }));
    const options = { retriever: "interrupted", jobId: "bulk-ingest" };
    expect(await corpus.ingest(docs, options)).toEqual({ pending: "bulk-ingest" });
    expect(await corpus.ingest(docs, options)).toEqual({ pending: "bulk-ingest" });
    await expect(corpus.delete(["doc0"])).rejects.toMatchObject({ code: "knowledge.busy" });
    await expect(corpus.destroy()).rejects.toMatchObject({ code: "knowledge.busy" });
    await clock.advance(1000);
    expect(await corpus.jobs.get("bulk-ingest")).toEqual({ state: "pending", completed: 8, total: 40 });
    await clock.advance(1000).catch(() => undefined);
    expect(await corpus.jobs.get("bulk-ingest")).toEqual({ state: "pending", completed: 10, total: 40 });
    for (let i = 0; i < 4; i++) await clock.advance(1000);
    expect(await corpus.jobs.get("bulk-ingest")).toEqual({ state: "completed", completed: 40, total: 40 });
    expect(await corpus.search("Passage")).toHaveLength(40);
    expect(await corpus.ingest(docs, options)).toEqual({ indexed: 40 });
    await expect(corpus.ingest([{ id: "changed", text: "different" }], options)).rejects.toMatchObject({
      code: "knowledge.indexConflict",
    });
    await corpus.delete(["doc0"]);
    expect(await corpus.ingest(docs, options)).toEqual({ indexed: 40 });
    expect(await corpus.search("Passage")).toHaveLength(39);
    await corpus.destroy();
    expect(await corpus.search("Passage", { retriever: "interrupted" })).toEqual([]);
  });

  it("completes a bulk Tool Job and continues its Thread", async () => {
    await scope.agents.put({
      agentId: "knowledge-importer",
      name: "Importer",
      instructions: [],
      model: { id: "test/model" },
      tools: ["ingest_documents"],
      policy: [{ match: { tool: "*" }, effect: "allow" }],
    });
    provider.script([[reply.toolCall("ingest_documents", { name: "tool-ingest" }, "import")], "Imported."]);
    const thread = scope.thread({ agent: "knowledge-importer", threadId: "importer" });
    const parked = await thread.send(message);
    expect(parked).toContainEvent({ type: "job.started" });
    for (let i = 0; i < 5; i++) await clock.advance(1000);
    await expect.poll(async () => (await thread.events()).some((event) => event.type === "turn.completed")).toBe(true);
    const events = await thread.events();
    expect(events).toContainEvent({ type: "job.completed" });
    expect(events).toContainEvent({ type: "tool.result", id: "import", isError: false });
    expect((await scope.knowledge("tool-ingest").search("Record")).length).toBe(10);
  });

  it("keeps bulk ingestion moving after the originating Thread cancels its Job", async () => {
    provider.script([[reply.toolCall("ingest_documents", { name: "cancelled-ingest" }, "cancel-import")]]);
    const thread = scope.thread({ agent: "knowledge-importer", threadId: "cancel-importer" });
    const parked = await thread.send(message);
    expect(parked).toContainEvent({ type: "job.started" });
    await thread.cancel();
    for (let i = 0; i < 5; i++) await clock.advance(1000);
    const corpus = scope.knowledge("cancelled-ingest");
    expect(
      await corpus.ingest(
        Array.from({ length: 40 }, (_, i) => ({ id: `new${i}`, text: "Next batch" })),
        { jobId: "next-batch" },
      ),
    ).toEqual({ pending: "next-batch" });
    for (let i = 0; i < 5; i++) await clock.advance(1000);
    expect(await corpus.jobs.get("next-batch")).toEqual({ state: "completed", completed: 40, total: 40 });
  });
});
