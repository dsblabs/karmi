import type { Embedder, VectorRow } from "@karmi/core";
import type { VectorIndex } from "../src/vectors";

// Each dimension is one topic of the guides. A text gets a 1 for each topic that it names, thus a question with
// different words finds the guide of the same topic.
const TOPICS = [
  /money|refund|return/i,
  /milk|allergen|dairy/i,
  /bean|fresh|flavour/i,
  /internet|network|wi-?fi|password/i,
  /open|close|hours/i,
];

/** A deterministic Embedder for the tests. It needs no Workers AI and gives equal vectors for equal topics. */
export const topicEmbedder: Embedder = {
  model: "test/topics",
  dims: TOPICS.length + 1,
  metric: "cosine",
  async embed(texts) {
    return texts.map((text) => {
      // The last dimension is small and never zero, thus a text with no topic still has a valid vector.
      const values = [...TOPICS.map((topic) => (topic.test(text) ? 1 : 0)), 0.1];
      const length = Math.hypot(...values);
      return new Float32Array(values.map((value) => value / length));
    });
  },
};

const rows = new Map<string, VectorRow>();

/** Each `scope/id` that a delete removed from the index, in order. A test empties it before it acts. */
export const deletedIds: string[] = [];
const key = (scope: string, id: string) => `${scope}/${id}`;

/**
 * An external vector index in the memory of the test Worker. Each Scope is a namespace, as in Vectorize. It applies
 * each write at once.
 */
export const memoryIndex: VectorIndex = {
  store: {
    async upsert(ns, batch) {
      for (const row of batch) rows.set(key(ns, row.id), row);
    },
    async query(ns, vector, options) {
      const hits: Array<{ id: string; score: number }> = [];
      for (const [name, row] of rows)
        if (name.startsWith(`${ns}/`) && row.metadata.knowledge === options.knowledge)
          hits.push({
            id: row.id,
            score: row.values.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0),
          });
      return hits.sort((left, right) => right.score - left.score).slice(0, options.topK);
    },
    async deleteByIds(ns, ids) {
      for (const id of ids) if (rows.delete(key(ns, id))) deletedIds.push(key(ns, id));
    },
  },
  async ids(scope, knowledge) {
    return [...rows]
      .filter(([name, row]) => name.startsWith(`${scope}/`) && row.metadata.knowledge === knowledge)
      .map(([, row]) => row.id);
  },
};
