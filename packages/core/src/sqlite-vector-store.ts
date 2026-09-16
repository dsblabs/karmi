import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import {
  validateVector,
  validateVectorQuery,
  type EmbeddingIndex,
  type VectorHit,
  type VectorQuery,
  type VectorRow,
  type VectorStore,
} from "./vector-store";

type Row = { id: string; values_blob: ArrayBuffer };
/** Scans Float32 vectors in SQLite, keeping at most maxChunks vectors in each read. */
export class SqliteBruteForceStore implements VectorStore {
  /** Defaults to pages of 1000 chunks; see docs/research/vector-workerd-timings.md. */
  constructor(
    private readonly sql: SqlStorage,
    private readonly index: EmbeddingIndex,
    private readonly maxChunks = 1000,
  ) {
    if (!Number.isInteger(maxChunks) || maxChunks < 1)
      throw new KarmiError("knowledge.invalid", "maxChunks must be a positive integer.");
    sql.exec(`CREATE TABLE IF NOT EXISTS vectors (
      ns TEXT NOT NULL, id TEXT NOT NULL, knowledge TEXT NOT NULL, doc TEXT NOT NULL,
      values_blob BLOB NOT NULL, PRIMARY KEY(ns, id)
    ); CREATE INDEX IF NOT EXISTS vectors_corpus ON vectors(ns, knowledge, id);`);
  }
  async upsert(ns: ScopeId, rows: VectorRow[]): Promise<void> {
    for (const row of rows) validateVector(row.values, this.index.dims);
    for (const row of rows)
      this.sql.exec(
        `INSERT INTO vectors VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ns, id) DO UPDATE SET knowledge=excluded.knowledge,
        doc=excluded.doc, values_blob=excluded.values_blob`,
        ns,
        row.id,
        row.metadata.knowledge,
        row.metadata.doc,
        row.values.slice().buffer,
      );
  }
  async query(ns: ScopeId, vector: Float32Array, options: VectorQuery): Promise<VectorHit[]> {
    validateVector(vector, this.index.dims);
    validateVectorQuery(options);
    if (options.doc?.length === 0) return [];
    const best: VectorHit[] = [];
    let after: string | undefined;
    while (true) {
      const rows: Row[] = this.sql
        .exec<Row>(
          `SELECT id, values_blob FROM vectors
        WHERE ns = ? AND knowledge = ? ${after === undefined ? "" : "AND id > ?"}
        ${options.doc ? "AND doc IN (SELECT value FROM json_each(?))" : ""}
        ORDER BY id LIMIT ?`,
          ns,
          options.knowledge,
          ...(after === undefined ? [] : [after]),
          ...(options.doc ? [JSON.stringify(options.doc)] : []),
          this.maxChunks,
        )
        .toArray();
      for (const row of rows) {
        best.push({ id: row.id, score: similarity(vector, new Float32Array(row.values_blob), this.index.metric) });
        best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (best.length > options.topK) best.pop();
      }
      const last = rows.at(-1);
      if (!last || rows.length < this.maxChunks) return best;
      after = last.id;
    }
  }
  async deleteByIds(ns: ScopeId, ids: string[]): Promise<void> {
    for (const id of ids) this.sql.exec("DELETE FROM vectors WHERE ns = ? AND id = ?", ns, id);
  }
  async deleteAll(ns: ScopeId, knowledge: string): Promise<void> {
    this.sql.exec("DELETE FROM vectors WHERE ns = ? AND knowledge = ?", ns, knowledge);
  }
}
function similarity(a: Float32Array, b: Float32Array, metric: EmbeddingIndex["metric"]): number {
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
