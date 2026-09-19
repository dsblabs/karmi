import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EmbeddingIndex } from "../src/index";
import { openKnowledgeDatabase } from "../src/db/knowledge/database";
import { createSqliteBruteForceStore } from "../src/sqlite-vector-store";

const index: EmbeddingIndex = { model: "test", dims: 2, metric: "cosine" };

describe("SQLite vector store", () => {
  it("ranks across pages and isolates identical ids by namespace and Knowledge", async () => {
    const stub = env.KARMI_KNOWLEDGE.getByName("store-conformance");
    await runInDurableObject(stub, async (_, state) => {
      const store = createSqliteBruteForceStore(openKnowledgeDatabase(state.storage.sql), index, 1);
      await store.upsert("one", [
        { id: "a", values: new Float32Array([0, 1]), metadata: { knowledge: "faq", doc: "a" } },
        { id: "b", values: new Float32Array([1, 0]), metadata: { knowledge: "faq", doc: "b" } },
        { id: "c", values: new Float32Array([1, 1]), metadata: { knowledge: "other", doc: "c" } },
      ]);
      await store.upsert("two", [
        { id: "b", values: new Float32Array([0, 1]), metadata: { knowledge: "faq", doc: "b" } },
      ]);
      const query = new Float32Array([1, 0]);
      const options = { topK: 2, knowledge: "faq" };
      expect(await store.query("one", query, options)).toEqual([
        { id: "b", score: 1 },
        { id: "a", score: 0 },
      ]);
      expect(await store.query("one", query, { ...options, doc: ["a"] })).toEqual([{ id: "a", score: 0 }]);
      expect(await store.query("one", query, { ...options, doc: [] })).toEqual([]);
      await store.deleteByIds("two", ["b"]);
      expect(await store.query("one", query, options)).toHaveLength(2);
      await store.deleteByIds("one", ["a", "b"]);
      expect(await store.query("one", query, options)).toEqual([]);
      expect(await store.query("one", query, { ...options, knowledge: "other" })).toHaveLength(1);
    });
  });
  it.each(["cosine", "dot-product", "euclidean"] as const)(
    "scores %s with finite results and rejects malformed vectors",
    async (metric) => {
      await runInDurableObject(env.KARMI_KNOWLEDGE.getByName(`metric-${metric}`), async (_, state) => {
        const store = createSqliteBruteForceStore(openKnowledgeDatabase(state.storage.sql), { ...index, metric });
        await store.upsert("one", [
          { id: "near", values: new Float32Array([1, 0]), metadata: { knowledge: "faq", doc: "a" } },
          { id: "zero", values: new Float32Array([0, 0]), metadata: { knowledge: "faq", doc: "a" } },
        ]);
        const hits = await store.query("one", new Float32Array([1, 0]), { knowledge: "faq", topK: 2 });
        expect(hits[0]).toEqual({ id: "near", score: metric === "euclidean" ? -0 : 1 });
        expect(hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
        await expect(
          store.upsert("one", [
            { id: "bad", values: new Float32Array([NaN, 0]), metadata: { knowledge: "faq", doc: "bad" } },
          ]),
        ).rejects.toMatchObject({ code: "knowledge.invalid" });
        await expect(store.query("one", new Float32Array([1]), { knowledge: "faq", topK: 2 })).rejects.toMatchObject({
          code: "knowledge.invalid",
        });
      });
    },
  );
});
