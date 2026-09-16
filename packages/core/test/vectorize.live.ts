import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { VectorizeStore } from "../src/index";

it("isolates namespaces, filters documents and deletes a live mirror from its ledger", async () => {
  await runInDurableObject(env.KARMI_KNOWLEDGE.getByName(`live-${crypto.randomUUID()}`), async (_, state) => {
    const binding = env.KARMI_LIVE_VECTORS;
    if (!binding) throw new Error("Missing live Vectorize binding.");
    const store = new VectorizeStore(binding, state.storage.sql);
    const ns = `test_${crypto.randomUUID()}`,
      other = `test_${crypto.randomUUID()}`;
    const query = new Float32Array([1, 0]);
    const options = { knowledge: "faq", topK: 10 };
    try {
      await store.upsert(ns, [
        { id: "same", values: query, metadata: { knowledge: "faq", doc: "a" } },
        { id: "other", values: query, metadata: { knowledge: "other", doc: "b" } },
      ]);
      await store.upsert(other, [{ id: "same", values: query, metadata: { knowledge: "faq", doc: "a" } }]);
      await expect
        .poll(() => store.query(ns, query, options), { timeout: 90000, interval: 1000 })
        .toMatchObject([{ id: "same" }]);
      await expect
        .poll(() => store.query(other, query, options), { timeout: 90000, interval: 1000 })
        .toMatchObject([{ id: "same" }]);
      expect(await store.query(ns, query, { ...options, doc: ["b"] })).toEqual([]);
      await store.deleteByIds(ns, ["same"]);
      expect(await store.query(ns, query, options)).toEqual([]);
      expect(await store.query(other, query, options)).toHaveLength(1);
      await store.deleteAll(ns, "other");
      expect(await store.query(ns, query, { ...options, knowledge: "other" })).toEqual([]);
    } finally {
      await store.deleteAll(ns, "faq");
      await store.deleteAll(ns, "other");
      await store.deleteAll(other, "faq");
    }
  });
});
