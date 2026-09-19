import { describe, expect, it } from "vitest";
import { VectorizeStore } from "../src/index";

describe("Vectorize store", () => {
  it("preserves canonical vector ids across writes, search and deletion", async () => {
    const vectors = new Map<string, VectorizeVector>();
    const deleted: string[][] = [];
    const index: Pick<Vectorize, "upsert" | "query" | "deleteByIds"> = {
      async upsert(rows) {
        for (const row of rows) vectors.set(row.id, row);
        return { mutationId: "upsert" };
      },
      async query() {
        return { matches: [{ id: "canonical-id", score: 0.75 }], count: 1 };
      },
      async deleteByIds(ids) {
        deleted.push(ids);
        for (const id of ids) vectors.delete(id);
        return { mutationId: "delete" };
      },
    };
    const store = new VectorizeStore(index);

    await store.upsert("acme", [
      {
        id: "canonical-id",
        values: new Float32Array([1, 0]),
        metadata: { knowledge: "faq", doc: "returns" },
      },
    ]);

    expect(vectors.get("canonical-id")).toMatchObject({ id: "canonical-id", namespace: "acme" });
    await expect(store.query("acme", new Float32Array([1, 0]), { knowledge: "faq", topK: 1 })).resolves.toEqual([
      { id: "canonical-id", score: 0.75 },
    ]);
    await store.deleteByIds("acme", ["canonical-id"]);
    expect(deleted).toEqual([["canonical-id"]]);
  });
});
