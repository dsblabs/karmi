import { and, asc, eq, gt } from "drizzle-orm";
import { chunks, vectorIds, vectors } from "./db/knowledge/schema";
import type { KnowledgeDatabase } from "./db/knowledge/database";
import { keys } from "./keys";
import type { KnowledgeChunk } from "./knowledge";
import { createSqliteBruteForceStore } from "./sqlite-vector-store";
import type { KnowledgeRef, Passage } from "./retriever";
import type { EmbeddingIndex, VectorHit, VectorRow, VectorStore } from "./vector-store";

/** Keeps vector ids and values durably before sending them to an external mirror. */
export class VectorLedger {
  readonly local: VectorStore;

  constructor(
    private readonly db: KnowledgeDatabase,
    private readonly ref: KnowledgeRef,
    index: EmbeddingIndex,
    maxChunks?: number,
  ) {
    this.local = createSqliteBruteForceStore(db, index, maxChunks);
  }

  async put(values: KnowledgeChunk[], embeddings: Float32Array[]): Promise<VectorRow[]> {
    const rows: VectorRow[] = [];
    for (let index = 0; index < values.length; index++) {
      const chunk = values[index];
      const vector = embeddings[index];
      if (!chunk || !vector) continue;
      const id = await keys.vector(this.ref.scope, this.ref.name, chunk.id, chunk.seq);
      this.db
        .insert(vectorIds)
        .values({ id, doc: chunk.id, seq: chunk.seq })
        .onConflictDoUpdate({ target: vectorIds.id, set: { doc: chunk.id, seq: chunk.seq } })
        .run();
      rows.push({ id, values: vector, metadata: { knowledge: this.ref.name, doc: chunk.id } });
    }
    await this.local.upsert(this.ref.scope, rows);
    return rows;
  }

  *idBatches(doc?: string): Generator<string[]> {
    let after = "";
    while (true) {
      const rows = this.db
        .select({ id: vectorIds.id })
        .from(vectorIds)
        .where(and(gt(vectorIds.id, after), doc === undefined ? undefined : eq(vectorIds.doc, doc)))
        .orderBy(asc(vectorIds.id))
        .limit(1000)
        .all();
      const last = rows.at(-1);
      if (!last) return;
      yield rows.map((row) => row.id);
      after = last.id;
    }
  }

  async remove(ids: string[]): Promise<void> {
    await this.local.deleteByIds(this.ref.scope, ids);
    for (const id of ids) this.db.delete(vectorIds).where(eq(vectorIds.id, id)).run();
  }

  passages(hits: VectorHit[]): Passage[] {
    const passages: Passage[] = [];
    for (const hit of hits) {
      const row = this.db
        .select({ doc: chunks.doc, seq: chunks.seq, text: chunks.text, meta: chunks.meta })
        .from(vectorIds)
        .innerJoin(chunks, and(eq(chunks.doc, vectorIds.doc), eq(chunks.seq, vectorIds.seq)))
        .where(eq(vectorIds.id, hit.id))
        .get();
      if (row)
        passages.push({
          docId: row.doc,
          seq: row.seq,
          text: row.text,
          score: hit.score,
          metadata: row.meta,
        });
    }
    return passages;
  }

  *batches(): Generator<VectorRow[]> {
    let after = "";
    while (true) {
      const rows = this.db
        .select({ id: vectors.id, doc: vectors.doc, values: vectors.valuesBlob })
        .from(vectors)
        .where(and(eq(vectors.ns, this.ref.scope), eq(vectors.knowledge, this.ref.name), gt(vectors.id, after)))
        .orderBy(asc(vectors.id))
        .limit(100)
        .all();
      const last = rows.at(-1);
      if (!last) return;
      yield rows.map((row) => ({
        id: row.id,
        values: float32(row.values),
        metadata: { knowledge: this.ref.name, doc: row.doc },
      }));
      after = last.id;
    }
  }
}

function float32(value: ArrayBuffer | Uint8Array): Float32Array {
  return value instanceof ArrayBuffer
    ? new Float32Array(value)
    : new Float32Array(value.buffer, value.byteOffset, value.byteLength / Float32Array.BYTES_PER_ELEMENT);
}
