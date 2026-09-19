import { and, eq, sql } from "drizzle-orm";
import { openKnowledgeDatabase, type KnowledgeDatabase } from "./db/knowledge/database";
import { vectors } from "./db/vector-schema";
import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import { similarity } from "./vector-ranking";
import {
  validateVector,
  validateVectorQuery,
  type EmbeddingIndex,
  type VectorHit,
  type VectorQuery,
  type VectorRow,
  type VectorStore,
} from "./vector-store";

type Row = { id: string; valuesBlob: ArrayBuffer };

class DrizzleBruteForceStore implements VectorStore {
  constructor(
    private readonly db: KnowledgeDatabase,
    private readonly index: EmbeddingIndex,
    private readonly maxChunks = 1000,
  ) {
    if (!Number.isInteger(maxChunks) || maxChunks < 1)
      throw new KarmiError("knowledge.invalid", "maxChunks must be a positive integer.");
  }

  async upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    for (const row of rows) validateVector(row.values, this.index.dims);
    for (const row of rows)
      this.db
        .insert(vectors)
        .values({
          ns,
          id: row.id,
          knowledge: row.metadata.knowledge,
          doc: row.metadata.doc,
          valuesBlob: row.values.slice().buffer,
        })
        .onConflictDoUpdate({
          target: [vectors.ns, vectors.id],
          set: {
            knowledge: row.metadata.knowledge,
            doc: row.metadata.doc,
            valuesBlob: row.values.slice().buffer,
          },
        })
        .run();
  }

  async query(ns: ScopeId, vector: Float32Array, options: VectorQuery): Promise<VectorHit[]> {
    validateVector(vector, this.index.dims);
    validateVectorQuery(options);
    if (options.doc?.length === 0) return [];
    const best: VectorHit[] = [];
    let after: string | undefined;
    while (true) {
      const afterClause = after === undefined ? sql`` : sql`AND id > ${after}`;
      const docsClause = options.doc
        ? sql`AND doc IN (SELECT value FROM json_each(${JSON.stringify(options.doc)}))`
        : sql``;
      const rows = this.db.all<Row>(sql`SELECT id, values_blob AS valuesBlob FROM vectors
        WHERE ns = ${ns} AND knowledge = ${options.knowledge} ${afterClause} ${docsClause}
        ORDER BY id LIMIT ${this.maxChunks}`);
      for (const row of rows) {
        best.push({ id: row.id, score: similarity(vector, new Float32Array(row.valuesBlob), this.index.metric) });
        best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (best.length > options.topK) best.pop();
      }
      const last = rows.at(-1);
      if (!last || rows.length < this.maxChunks) return best;
      after = last.id;
    }
  }

  async deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    for (const id of ids)
      this.db
        .delete(vectors)
        .where(and(eq(vectors.ns, ns), eq(vectors.id, id)))
        .run();
  }

  async deleteAll(ns: ScopeId, knowledge: string): Promise<void> {
    this.db
      .delete(vectors)
      .where(and(eq(vectors.ns, ns), eq(vectors.knowledge, knowledge)))
      .run();
  }
}

/** Creates the internal SQLite vector store over an already migrated Knowledge database. */
export function createSqliteBruteForceStore(
  db: KnowledgeDatabase,
  index: EmbeddingIndex,
  maxChunks?: number,
): VectorStore {
  return new DrizzleBruteForceStore(db, index, maxChunks);
}

/** Scans Float32 vectors in SQLite, keeping at most maxChunks vectors in each read. */
export class SqliteBruteForceStore implements VectorStore {
  private readonly store: VectorStore;

  /** Defaults to pages of 1000 chunks; the storage must already have the Knowledge migrations. */
  constructor(storage: SqlStorage, index: EmbeddingIndex, maxChunks?: number) {
    this.store = createSqliteBruteForceStore(openKnowledgeDatabase(storage), index, maxChunks);
  }

  upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    return this.store.upsert(ns, rows);
  }
  query(ns: ScopeId, vector: Float32Array, options: VectorQuery): Promise<VectorHit[]> {
    return this.store.query(ns, vector, options);
  }
  deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    return this.store.deleteByIds(ns, ids);
  }
  deleteAll(ns: ScopeId, knowledge: string): Promise<void> {
    return this.store.deleteAll(ns, knowledge);
  }
}
