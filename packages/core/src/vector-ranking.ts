import type { Passage } from "./retriever";
import type { EmbeddingIndex } from "./vector-store";

/** Combines lexical and vector passage ranks using reciprocal-rank fusion. */
export function fuseRanks(lexical: Passage[], vectors: Passage[], constant: number): Passage[] {
  const hits = new Map<string, Passage>();
  for (const list of [lexical, vectors]) {
    list.forEach((hit, rank) => {
      const key = JSON.stringify([hit.docId, hit.seq]);
      const score = (hits.get(key)?.score ?? 0) + 1 / (constant + rank + 1);
      hits.set(key, { ...hit, score, source: "hybrid" });
    });
  }
  return [...hits.values()].sort(
    (a, b) => b.score - a.score || a.docId.localeCompare(b.docId) || (a.seq ?? 0) - (b.seq ?? 0),
  );
}

/** Scores two vectors so that larger values rank first for every supported metric. */
export function similarity(a: Float32Array, b: Float32Array, metric: EmbeddingIndex["metric"]): number {
  let dot = 0,
    aa = 0,
    bb = 0,
    distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
    distance += (x - y) ** 2;
  }
  if (metric === "euclidean") return -Math.sqrt(distance);
  if (metric === "dot-product") return dot;
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
