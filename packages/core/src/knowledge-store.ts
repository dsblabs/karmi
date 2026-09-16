import { KarmiError } from "./errors";
import { decodeKnowledgeMetadata, KNOWLEDGE_INLINE_LIMIT, type KnowledgeChunk } from "./knowledge";
import { ftsQuery } from "./memory";
import type { KnowledgeDocument, Passage } from "./retriever";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS knowledge_head (
    scope TEXT NOT NULL, name TEXT NOT NULL, options TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, meta TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY, doc TEXT NOT NULL, seq INTEGER NOT NULL,
    text TEXT NOT NULL, meta TEXT NOT NULL, UNIQUE(doc, seq)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY, request TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ingest_pending ON ingest_jobs(notified) WHERE notified = 0;
  CREATE TABLE IF NOT EXISTS ingest_documents (
    job TEXT NOT NULL, seq INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(job, seq)
  );
`;
type ChunkRow = { doc: string; seq: number; text: string; meta: string; score: number };

/** Owns the corpus ledger and its transactionally maintained FTS5 index. */
export class KnowledgeStore {
  constructor(readonly storage: DurableObjectStorage) {
    storage.sql.exec(SCHEMA);
  }

  get sql(): SqlStorage {
    return this.storage.sql;
  }

  replace(doc: KnowledgeDocument, chunks: KnowledgeChunk[]): void {
    this.storage.transactionSync(() => {
      this.remove([doc.id]);
      const meta = JSON.stringify(doc.metadata ?? {});
      this.sql.exec("INSERT INTO documents (id, text, meta) VALUES (?, ?, ?)", doc.id, doc.text, meta);
      for (const chunk of chunks)
        this.sql.exec(
          "INSERT INTO chunks (doc, seq, text, meta) VALUES (?, ?, ?, ?)",
          doc.id,
          chunk.seq,
          chunk.text,
          meta,
        );
    });
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      this.sql.exec("DELETE FROM chunks WHERE doc = ?", id);
      this.sql.exec("DELETE FROM documents WHERE id = ?", id);
    }
  }

  search(query: string, topK = 10): Passage[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.sql
      .exec<ChunkRow>(
        `SELECT c.doc, c.seq, c.text, c.meta, -bm25(chunks_fts) AS score
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts), c.doc, c.seq LIMIT ?`,
        match,
        topK,
      )
      .toArray()
      .map(passage);
  }

  inline(): string {
    const { size } = this.sql
      .exec<{ size: number }>("SELECT coalesce(sum(length(text)), 0) + max(count(*) - 1, 0) * 2 AS size FROM documents")
      .one();
    if (size > KNOWLEDGE_INLINE_LIMIT)
      throw new KarmiError(
        "knowledge.inlineLimit",
        `Knowledge corpus has ${size} characters; inline limit is ${KNOWLEDGE_INLINE_LIMIT}. Use mode: "search".`,
      );
    return this.sql
      .exec<{ text: string }>("SELECT text FROM documents ORDER BY id")
      .toArray()
      .map((row) => row.text)
      .join("\n\n");
  }

  clear(): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks");
      this.sql.exec("DELETE FROM documents");
      this.sql.exec("DELETE FROM ingest_documents");
      this.sql.exec("DELETE FROM ingest_jobs");
      this.sql.exec("DELETE FROM knowledge_head");
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
