import * as z from "zod/mini";
import type { ScopeId } from "./context";
import {
  validateVectorQuery,
  type EmbeddingIndex,
  type VectorHit,
  type VectorQuery,
  type VectorRow,
  type VectorStore,
} from "./vector-store";

const queryResponseSchema = z.object({ matches: z.array(z.object({ id: z.string(), score: z.number() })) });
type VectorizeClient = Pick<Vectorize, "upsert" | "query" | "deleteByIds">;

/** Mirrors vectors into Vectorize while preserving the Framework's opaque vector ids. */
export class VectorizeStore implements VectorStore {
  /** The index needs string metadata indexes on knowledge and doc; metric defaults to cosine and must match the index. */
  constructor(
    private readonly index: VectorizeClient,
    private readonly metric: EmbeddingIndex["metric"] = "cosine",
  ) {}
  async upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 1000) {
      const batch: VectorizeVector[] = [];
      for (const row of rows.slice(offset, offset + 1000)) {
        batch.push({ id: row.id, namespace: ns, values: row.values, metadata: row.metadata });
      }
      await this.index.upsert(batch);
    }
  }
  async query(ns: ScopeId, vector: Float32Array, options: VectorQuery): Promise<VectorHit[]> {
    validateVectorQuery(options);
    if (options.doc?.length === 0) return [];
    const result = z.parse(
      queryResponseSchema,
      await this.index.query(vector, {
        namespace: ns,
        topK: options.topK,
        returnMetadata: "none",
        returnValues: false,
        filter: { knowledge: options.knowledge, ...(options.doc && { doc: { $in: options.doc } }) },
      }),
    );
    return result.matches.map((hit) => ({
      id: hit.id,
      score: this.metric === "cosine" ? hit.score : -hit.score,
    }));
  }
  async deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000);
      await this.index.deleteByIds(batch);
    }
  }
}
