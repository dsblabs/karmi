import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { chunks, documents, ingestDocuments, ingestJobs, knowledgeHead, knowledgeSchema } from "./db/knowledge/schema";
import { KarmiError } from "./errors";
import { decodeKnowledgeMetadata, KNOWLEDGE_INLINE_LIMIT, type KnowledgeChunk } from "./knowledge";
import { ftsQuery } from "./memory";
import type { KnowledgeDocument, Passage } from "./retriever";

/** The typed database shared by internal Knowledge storage helpers. */
export type KnowledgeDatabase = DrizzleSqliteDODatabase<typeof knowledgeSchema>;
type ChunkRow = { doc: string; seq: number; text: string; meta: string; score: number };

/** Owns the corpus ledger and its transactionally maintained FTS5 index. */
export class KnowledgeStore {
  constructor(readonly db: KnowledgeDatabase) {}

  replace(doc: KnowledgeDocument, values: KnowledgeChunk[]): void {
    this.db.transaction((tx) => {
      tx.delete(chunks).where(eq(chunks.doc, doc.id)).run();
      tx.delete(documents).where(eq(documents.id, doc.id)).run();
      const meta = doc.metadata ?? {};
      tx.insert(documents).values({ id: doc.id, text: doc.text, meta }).run();
      for (const chunk of values)
        tx.insert(chunks).values({ doc: doc.id, seq: chunk.seq, text: chunk.text, meta }).run();
    });
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      this.db.delete(chunks).where(eq(chunks.doc, id)).run();
      this.db.delete(documents).where(eq(documents.id, id)).run();
    }
  }

  search(query: string, topK = 10): Passage[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db
      .all<ChunkRow>(
        sql`SELECT c.doc, c.seq, c.text, c.meta, -bm25(chunks_fts) AS score
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ${match} ORDER BY bm25(chunks_fts), c.doc, c.seq LIMIT ${topK}`,
      )
      .map(passage);
  }

  inline(): string {
    const size =
      this.db
        .select({
          size: sql<number>`coalesce(sum(length(${documents.text})), 0) + max(count(*) - 1, 0) * 2`,
        })
        .from(documents)
        .get()?.size ?? 0;
    if (size > KNOWLEDGE_INLINE_LIMIT)
      throw new KarmiError(
        "knowledge.inlineLimit",
        `Knowledge corpus has ${size} characters; inline limit is ${KNOWLEDGE_INLINE_LIMIT}. Use mode: "search".`,
      );
    const rows = this.db.select({ text: documents.text }).from(documents).orderBy(asc(documents.id)).all();
    return rows.map((row) => row.text).join("\n\n");
  }

  clear(): void {
    this.db.transaction((tx) => {
      tx.delete(chunks).run();
      tx.delete(documents).run();
      tx.delete(ingestDocuments).run();
      tx.delete(ingestJobs).run();
      tx.delete(knowledgeHead).run();
    });
  }
}

function passage(row: ChunkRow): Passage {
  return {
    docId: row.doc,
    seq: row.seq,
    text: row.text,
    score: row.score,
    metadata: decodeKnowledgeMetadata(row.meta),
  };
}
