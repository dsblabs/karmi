import * as z from "zod/mini";
import type { ScopeId } from "./context";
import { keys } from "./keys";
import {
  validateVectorQuery,
  type EmbeddingIndex,
  type VectorHit,
  type VectorQuery,
  type VectorRow,
  type VectorStore,
} from "./vector-store";

const queryResponseSchema = z.object({ matches: z.array(z.object({ id: z.string(), score: z.number() })) });

/** Mirrors vectors into Vectorize, keeping its id mapping in the Knowledge ledger before each write. */
export class VectorizeStore implements VectorStore {
  /** The index needs string metadata indexes on knowledge and doc; metric defaults to cosine and must match the index. */
  constructor(
    private readonly index: Vectorize,
    private readonly sql: SqlStorage,
    private readonly metric: EmbeddingIndex["metric"] = "cosine",
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS vectorize_ids (
      ns TEXT NOT NULL, id TEXT NOT NULL, remote_id TEXT NOT NULL, knowledge TEXT NOT NULL,
      PRIMARY KEY(ns, id), UNIQUE(ns, remote_id)
    ); CREATE INDEX IF NOT EXISTS vectorize_ids_corpus ON vectorize_ids(ns, knowledge, id);`);
  }
  async upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 1000) {
      const batch: VectorizeVector[] = [];
      for (const row of rows.slice(offset, offset + 1000)) {
        const id = await keys.vectorMirror(ns, row.id);
        this.sql.exec(
          "INSERT OR REPLACE INTO vectorize_ids VALUES (?, ?, ?, ?)",
          ns,
          row.id,
          id,
          row.metadata.knowledge,
        );
        batch.push({ id, namespace: ns, values: row.values, metadata: row.metadata });
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
    const hits: VectorHit[] = [];
    for (const hit of result.matches) {
      const row = this.sql
        .exec<{ id: string }>(
          "SELECT id FROM vectorize_ids WHERE ns = ? AND remote_id = ? AND knowledge = ?",
          ns,
          hit.id,
          options.knowledge,
        )
        .toArray()[0];
      if (row) hits.push({ id: row.id, score: this.metric === "cosine" ? hit.score : -hit.score });
    }
    return hits;
  }
  async deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000);
      await this.index.deleteByIds(await Promise.all(batch.map((id) => keys.vectorMirror(ns, id))));
      for (const id of batch) this.sql.exec("DELETE FROM vectorize_ids WHERE ns = ? AND id = ?", ns, id);
    }
  }
  async deleteAll(ns: ScopeId, knowledge: string): Promise<void> {
    while (true) {
      const ids = this.sql
        .exec<{ id: string }>(
          "SELECT id FROM vectorize_ids WHERE ns = ? AND knowledge = ? ORDER BY id LIMIT 1000",
          ns,
          knowledge,
        )
        .toArray();
      if (!ids.length) return;
      await this.deleteByIds(
        ns,
        ids.map((row) => row.id),
      );
    }
  }
}
