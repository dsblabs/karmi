import * as z from "zod/mini";
import { and, asc, eq } from "drizzle-orm";
import type { ScopeId } from "./context";
import { openKnowledgeDatabase, type KnowledgeDatabase } from "./db/knowledge/database";
import { vectorizeIds } from "./db/knowledge/schema";
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
  private readonly db: KnowledgeDatabase;

  /** The index needs string metadata indexes on knowledge and doc; metric defaults to cosine and must match the index. */
  constructor(
    private readonly index: Vectorize,
    storage: SqlStorage,
    private readonly metric: EmbeddingIndex["metric"] = "cosine",
  ) {
    this.db = openKnowledgeDatabase(storage);
  }
  async upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 1000) {
      const batch: VectorizeVector[] = [];
      for (const row of rows.slice(offset, offset + 1000)) {
        const id = await keys.vectorMirror(ns, row.id);
        this.db
          .insert(vectorizeIds)
          .values({ ns, id: row.id, remoteId: id, knowledge: row.metadata.knowledge })
          .onConflictDoUpdate({
            target: [vectorizeIds.ns, vectorizeIds.id],
            set: { remoteId: id, knowledge: row.metadata.knowledge },
          })
          .run();
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
      const row = this.db
        .select({ id: vectorizeIds.id })
        .from(vectorizeIds)
        .where(
          and(
            eq(vectorizeIds.ns, ns),
            eq(vectorizeIds.remoteId, hit.id),
            eq(vectorizeIds.knowledge, options.knowledge),
          ),
        )
        .get();
      if (row) hits.push({ id: row.id, score: this.metric === "cosine" ? hit.score : -hit.score });
    }
    return hits;
  }
  async deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000);
      await this.index.deleteByIds(await Promise.all(batch.map((id) => keys.vectorMirror(ns, id))));
      for (const id of batch)
        this.db
          .delete(vectorizeIds)
          .where(and(eq(vectorizeIds.ns, ns), eq(vectorizeIds.id, id)))
          .run();
    }
  }
  async deleteAll(ns: ScopeId, knowledge: string): Promise<void> {
    while (true) {
      const ids = this.db
        .select({ id: vectorizeIds.id })
        .from(vectorizeIds)
        .where(and(eq(vectorizeIds.ns, ns), eq(vectorizeIds.knowledge, knowledge)))
        .orderBy(asc(vectorizeIds.id))
        .limit(1000)
        .all();
      if (!ids.length) return;
      await this.deleteByIds(
        ns,
        ids.map((row) => row.id),
      );
    }
  }
}
