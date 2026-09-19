import { clearTestVectorMirror, interruptNextMirrorDelete, testVectorMirrorSize } from "./knowledge-fixtures";
import { describe, expect, it } from "vitest";
import { karmi, scope } from "./worker";

describe("Vector Knowledge", () => {
  it("finds semantic matches and replaces old chunks without crossing Scope boundaries", async () => {
    const corpus = scope.knowledge("semantic");
    await corpus.ingest(
      [
        { id: "pet", text: "kitten" },
        { id: "fruit", text: "apple" },
      ],
      { retriever: "semantic" },
    );
    expect((await corpus.search("cat"))[0]?.docId).toBe("pet");
    expect(await karmi.scope("other-vector-scope").knowledge("semantic").search("cat")).toEqual([]);
    await corpus.ingest([{ id: "pet", text: "pear" }]);
    expect((await corpus.search("cat")).map((hit) => hit.text)).not.toContain("kitten");
    await corpus.delete(["pet"]);
    expect((await corpus.search("cat")).map((hit) => hit.docId)).toEqual(["fruit"]);
    await corpus.destroy();
    expect(await corpus.search("cat")).toEqual([]);
  });
  it("fuses lexical and semantic ranks instead of returning the vector order", async () => {
    const corpus = scope.knowledge("hybrid");
    await corpus.ingest(
      [
        { id: "semantic", text: "kitten" },
        { id: "lexical", text: "cat", metadata: { origin: "manual" } },
        { id: "unrelated", text: "pear" },
      ],
      { retriever: "semantic" },
    );
    const hits = await corpus.search("cat", { settings: { mode: "hybrid", topK: 3 } });
    expect(hits[0]).toMatchObject({ docId: "lexical", metadata: { origin: "manual" }, source: "hybrid" });
    expect(hits[0]?.score).toBeCloseTo(0.03252, 5);
  });
  it("rebuilds a lost mirror from the ledger and fixes its embedding configuration", async () => {
    const corpus = scope.knowledge("rebuild");
    await corpus.ingest([{ id: "pet", text: "kitten" }], { retriever: "mirrored" });
    clearTestVectorMirror("test", "rebuild");
    expect(await corpus.search("cat")).toEqual([]);
    await corpus.rebuild();
    expect((await corpus.search("cat"))[0]?.text).toBe("kitten");
    await expect(
      corpus.ingest([{ id: "next", text: "apple" }], {
        index: { embedding: { model: "changed", dims: 3, metric: "cosine" } },
      }),
    ).rejects.toMatchObject({ code: "knowledge.indexConflict" });
    await corpus.destroy();
    await corpus.rebuild();
    expect(await corpus.search("cat")).toEqual([]);
  });
  it("accepts repeated chunking options when embedding configuration was inferred", async () => {
    const corpus = scope.knowledge("fixed-index");
    const options = { retriever: "semantic", index: { chunkSize: 20, overlap: 0 } };
    await corpus.ingest([{ id: "one", text: "kitten" }], options);
    await expect(corpus.ingest([{ id: "two", text: "pear" }], options)).resolves.toEqual({ indexed: 1 });
  });
  it("retries destruction after the external mirror applied a deletion", async () => {
    const corpus = scope.knowledge("destroy-retry");
    await corpus.ingest(
      [
        { id: "pet", text: "kitten" },
        { id: "fruit", text: "apple" },
      ],
      { retriever: "mirrored" },
    );
    expect(testVectorMirrorSize("test", "destroy-retry")).toBe(2);
    interruptNextMirrorDelete();
    await expect(corpus.destroy()).rejects.toThrow("acknowledged deletion");
    expect(testVectorMirrorSize("test", "destroy-retry")).toBe(1);
    await expect(corpus.destroy()).resolves.toBeUndefined();
    expect(testVectorMirrorSize("test", "destroy-retry")).toBe(0);
    expect(await corpus.search("cat")).toEqual([]);
  });
});
