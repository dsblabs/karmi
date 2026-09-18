import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { KnowledgeDocument } from "../../retriever";
import { vectorIds, vectors, vectorTables } from "../vector-schema";

export { vectorIds, vectors };

/** This table fixes the Scope, name and indexing options of one Knowledge corpus. */
export const knowledgeHead = sqliteTable("knowledge_head", {
  scope: text().notNull(),
  name: text().notNull(),
  options: text({ mode: "json" }).$type<unknown>().notNull(),
});
/** This table stores the original documents in a Knowledge corpus. */
export const documents = sqliteTable("documents", {
  id: text().primaryKey(),
  text: text().notNull(),
  meta: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
});
/** This table stores the searchable chunks derived from Knowledge documents. */
export const chunks = sqliteTable(
  "chunks",
  {
    id: integer().primaryKey(),
    doc: text().notNull(),
    seq: integer().notNull(),
    text: text().notNull(),
    meta: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [uniqueIndex("chunks_doc_seq_unique").on(table.doc, table.seq)],
);
/** This table checkpoints durable Knowledge ingest jobs. */
export const ingestJobs = sqliteTable(
  "ingest_jobs",
  {
    id: text().primaryKey(),
    request: text({ mode: "json" }).$type<unknown>().notNull(),
    completed: integer().notNull().default(0),
    total: integer().notNull(),
    notified: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("ingest_pending")
      .on(table.notified)
      .where(sql`${table.notified} = 0`),
  ],
);
/** This table stages the documents that remain in a durable ingest job. */
export const ingestDocuments = sqliteTable(
  "ingest_documents",
  {
    job: text().notNull(),
    seq: integer().notNull(),
    document: text({ mode: "json" }).$type<KnowledgeDocument>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.job, table.seq] })],
);

/** The complete relational schema of the Knowledge Durable Object. */
export const knowledgeSchema = {
  knowledgeHead,
  documents,
  chunks,
  ingestJobs,
  ingestDocuments,
  ...vectorTables,
};
