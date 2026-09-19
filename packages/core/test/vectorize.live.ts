import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { VectorizeStore } from "../src/index";

it("isolates namespaces, filters documents and deletes a live mirror from its ledger", async () => {
  await runInDurableObject(env.KARMI_KNOWLEDGE.getByName(`live-${crypto.randomUUID()}`), async () => {
    const binding = env.KARMI_LIVE_VECTORS;
    if (!binding) throw new Error("Missing live Vectorize binding.");
    const store = new VectorizeStore(binding);
    const ns = `test_${crypto.randomUUID()}`,
      other = `test_${crypto.randomUUID()}`;
    const nsId = `one-${crypto.randomUUID()}`,
      otherId = `two-${crypto.randomUUID()}`;
    const query = new Float32Array([1, 0]);
    const options = { knowledge: "faq", topK: 10 };
    try {
      await store.upsert(ns, [
        { id: nsId, values: query, metadata: { knowledge: "faq", doc: "a" } },
        { id: "other", values: query, metadata: { knowledge: "other", doc: "b" } },
      ]);
      await store.upsert(other, [{ id: otherId, values: query, metadata: { knowledge: "faq", doc: "a" } }]);
      await expect
        .poll(() => store.query(ns, query, options), { timeout: 90000, interval: 1000 })
        .toMatchObject([{ id: nsId }]);
      await expect
        .poll(() => store.query(other, query, options), { timeout: 90000, interval: 1000 })
        .toMatchObject([{ id: otherId }]);
      expect(await store.query(ns, query, { ...options, doc: ["b"] })).toEqual([]);
      const remote = await binding.query(query, { namespace: ns, filter: { knowledge: "faq" }, topK: 10 });
      const remoteOther = await binding.query(query, { namespace: other, filter: { knowledge: "faq" }, topK: 10 });
      const deletedIds = remote.matches.map((hit) => hit.id);
      const retainedIds = remoteOther.matches.map((hit) => hit.id);
      expect(deletedIds).toHaveLength(1);
      expect(retainedIds).toHaveLength(1);
      expect(deletedIds).toEqual([nsId]);
      expect(retainedIds).toEqual([otherId]);
      await store.deleteByIds(ns, [nsId]);
      await expect.poll(() => binding.getByIds(deletedIds), { timeout: 90000, interval: 1000 }).toEqual([]);
      expect(await binding.getByIds(retainedIds)).toHaveLength(1);
      expect(await store.query(ns, query, options)).toEqual([]);
      expect(await store.query(other, query, options)).toHaveLength(1);
      const otherCorpus = await binding.query(query, { namespace: ns, filter: { knowledge: "other" }, topK: 10 });
      expect(otherCorpus.matches).toHaveLength(1);
      await store.deleteByIds(ns, ["other"]);
      await expect
        .poll(() => binding.getByIds(otherCorpus.matches.map((hit) => hit.id)), { timeout: 90000, interval: 1000 })
        .toEqual([]);
      expect(await store.query(ns, query, { ...options, knowledge: "other" })).toEqual([]);
    } finally {
      await store.deleteByIds(ns, [nsId, "other"]);
      await store.deleteByIds(other, [otherId]);
    }
  });
});
