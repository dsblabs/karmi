import type { KnowledgeChunk } from "./knowledge";
import type { KnowledgeRef, Passage } from "./retriever";
import { keys } from "./keys";
import { SqliteBruteForceStore } from "./sqlite-vector-store";
import type { EmbeddingIndex, VectorHit, VectorRow } from "./vector-store";
import { decodeKnowledgeMetadata } from "./knowledge";

type LedgerRow = { id: string; doc: string; values_blob: ArrayBuffer };
/** Keeps vector ids and values durably before sending them to an external mirror. */
export class VectorLedger {
  readonly local: SqliteBruteForceStore;
  constructor(
    private readonly sql: SqlStorage,
    private readonly ref: KnowledgeRef,
    index: EmbeddingIndex,
    maxChunks?: number,
  ) {
    this.local = new SqliteBruteForceStore(sql, index, maxChunks);
    sql.exec(`CREATE TABLE IF NOT EXISTS vector_ids (
      id TEXT PRIMARY KEY, doc TEXT NOT NULL, seq INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS vector_ids_doc ON vector_ids(doc);`);
  }
  async put(chunks: KnowledgeChunk[], values: Float32Array[]): Promise<VectorRow[]> {
    const rows: VectorRow[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i],
        vector = values[i];
      if (!chunk || !vector) continue;
      const id = await keys.vector(this.ref.scope, this.ref.name, chunk.id, chunk.seq);
      this.sql.exec("INSERT OR REPLACE INTO vector_ids VALUES (?, ?, ?)", id, chunk.id, chunk.seq);
      rows.push({ id, values: vector, metadata: { knowledge: this.ref.name, doc: chunk.id } });
    }
    await this.local.upsert(this.ref.scope, rows);
    return rows;
  }
  *idBatches(doc?: string): Generator<string[]> {
    let after = "";
    while (true) {
      const rows = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM vector_ids WHERE id > ? ${doc === undefined ? "" : "AND doc = ?"} ORDER BY id LIMIT 1000`,
          after,
          ...(doc === undefined ? [] : [doc]),
        )
        .toArray();
      const last = rows.at(-1);
      if (!last) return;
      yield rows.map((row) => row.id);
      after = last.id;
    }
  }
  async remove(ids: string[]): Promise<void> {
    await this.local.deleteByIds(this.ref.scope, ids);
    for (const id of ids) this.sql.exec("DELETE FROM vector_ids WHERE id = ?", id);
  }
  passages(hits: VectorHit[]): Passage[] {
    const passages: Passage[] = [];
    for (const hit of hits) {
      const row = this.sql
        .exec<{ doc: string; seq: number; text: string; meta: string }>(
          `SELECT c.doc, c.seq, c.text, c.meta FROM vector_ids v
         JOIN chunks c ON c.doc = v.doc AND c.seq = v.seq WHERE v.id = ?`,
          hit.id,
        )
        .toArray()[0];
      if (row)
        passages.push({
          docId: row.doc,
          seq: row.seq,
          text: row.text,
          score: hit.score,
          metadata: decodeKnowledgeMetadata(row.meta),
        });
    }
    return passages;
  }
  *batches(): Generator<VectorRow[]> {
    let after = "";
    while (true) {
      const rows = this.sql
        .exec<LedgerRow>(
          `SELECT id, doc, values_blob FROM vectors
        WHERE ns = ? AND knowledge = ? AND id > ? ORDER BY id LIMIT 100`,
          this.ref.scope,
          this.ref.name,
          after,
        )
        .toArray();
      const last = rows.at(-1);
      if (!last) return;
      yield rows.map((row) => ({
        id: row.id,
        values: new Float32Array(row.values_blob),
        metadata: { knowledge: this.ref.name, doc: row.doc },
      }));
      after = last.id;
    }
  }
}
