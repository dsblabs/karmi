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
