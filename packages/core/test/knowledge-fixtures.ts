import { SqliteBruteForceStore } from "../src/index";
import { defineRetriever, type KnowledgeChunk } from "../src/index";

const mirrors = new Map<string, Map<string, KnowledgeChunk[]>>();
const failed = new Set<string>();

/** A Retriever whose first write of document 10 fails after updating its external mirror. */
export const interruptedRetriever = defineRetriever({
  name: "interrupted",
  async index(chunks, ctx) {
    const key = `${ctx.knowledge.scope}/${ctx.knowledge.name}`;
    let mirror = mirrors.get(key);
    if (!mirror) {
      mirror = new Map();
      mirrors.set(key, mirror);
    }
    for (const chunk of chunks)
      mirror.set(
        chunk.id,
        chunks.filter((item) => item.id === chunk.id),
      );
    if (chunks.some((chunk) => chunk.id === "doc10") && !failed.has(key)) {
      failed.add(key);
      throw new Error("External index acknowledged the write before the connection broke.");
    }
  },
  async search(query, ctx) {
    return [...(mirrors.get(`${ctx.knowledge.scope}/${ctx.knowledge.name}`)?.values() ?? [])]
      .flat()
      .filter((chunk) => chunk.text.includes(query))
      .map((chunk) => ({ docId: chunk.id, seq: chunk.seq, text: chunk.text, score: 1 }));
  },
  async delete(ids, ctx) {
    const mirror = mirrors.get(`${ctx.knowledge.scope}/${ctx.knowledge.name}`);
    for (const id of ids) mirror?.delete(id);
  },
  async destroy(ctx) {
    mirrors.delete(`${ctx.knowledge.scope}/${ctx.knowledge.name}`);
  },
});

/** Whether the interrupted Retriever still mirrors a corpus, which a destroy must clear. */
export const mirrored = (scope: string, name: string): boolean => mirrors.has(`${scope}/${name}`);

/** A deterministic embedding provider for semantic retrieval tests. */
export const semanticEmbedder: import("../src/index").Embedder = {
  model: "test/semantic",
  dims: 2,
  metric: "cosine",
  async embed(texts, kind) {
    return texts.map(
      (text) =>
        new Float32Array(
          text === "cat" && kind === "document" ? [0.8, 0.2] : /cat|kitten/.test(text) ? [1, 0] : [0, 1],
        ),
    );
  },
};

/** A separate SQLite namespace simulates a rebuildable external mirror without remote services. */
export function sqliteMirror(
  ctx: import("../src/retriever").RetrieverContext<unknown>,
): import("../src/index").VectorStore {
  const store = new SqliteBruteForceStore(ctx.storage, semanticEmbedder);
  return {
    upsert: (ns, rows) => store.upsert(`mirror_${ns}`, rows),
    query: (ns, vector, options) => store.query(`mirror_${ns}`, vector, options),
    deleteByIds: (ns, ids) => store.deleteByIds(`mirror_${ns}`, ids),
    deleteAll: (ns, knowledge) => store.deleteAll(`mirror_${ns}`, knowledge),
  };
}
