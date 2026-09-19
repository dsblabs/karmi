import { defineRetriever, type KnowledgeChunk, type VectorRow, type VectorStore } from "../src/index";

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

const vectorMirror = new Map<string, VectorRow>();
let interruptMirrorDelete = false;

/** An in-memory Vector store that simulates a rebuildable external mirror. */
export const testVectorMirror: VectorStore = {
  async upsert(ns, rows) {
    for (const row of rows) vectorMirror.set(`${ns}/${row.id}`, row);
  },
  async query(ns, vector, options) {
    return [...vectorMirror]
      .filter(
        ([key, row]) =>
          key.startsWith(`${ns}/`) &&
          row.metadata.knowledge === options.knowledge &&
          (!options.doc || options.doc.includes(row.metadata.doc)),
      )
      .map(([, row]) => ({
        id: row.id,
        score: (row.values[0] ?? 0) * (vector[0] ?? 0) + (row.values[1] ?? 0) * (vector[1] ?? 0),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, options.topK);
  },
  async deleteByIds(ns, ids) {
    for (const id of ids) vectorMirror.delete(`${ns}/${id}`);
    if (interruptMirrorDelete) {
      interruptMirrorDelete = false;
      throw new Error("The external mirror acknowledged deletion before the connection broke.");
    }
  },
};

/** Makes the next external mirror deletion fail after applying the write. */
export function interruptNextMirrorDelete(): void {
  interruptMirrorDelete = true;
}

/** Removes one corpus from the external mirror to exercise ledger rebuilds. */
export function clearTestVectorMirror(ns: string, knowledge: string): void {
  for (const [key, row] of vectorMirror)
    if (key.startsWith(`${ns}/`) && row.metadata.knowledge === knowledge) vectorMirror.delete(key);
}

/** Counts the vectors for one corpus in the external test mirror. */
export function testVectorMirrorSize(ns: string, knowledge: string): number {
  return [...vectorMirror].filter(([key, row]) => key.startsWith(`${ns}/`) && row.metadata.knowledge === knowledge)
    .length;
}
