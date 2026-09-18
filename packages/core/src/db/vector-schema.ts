import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** This table maps stable vector ids back to their Knowledge chunks. */
export const vectorIds = sqliteTable(
  "vector_ids",
  {
    id: text().primaryKey(),
    doc: text().notNull(),
    seq: integer().notNull(),
  },
  (table) => [index("vector_ids_doc").on(table.doc)],
);
/** This table stores embedding vectors for the built-in brute-force index. */
export const vectors = sqliteTable(
  "vectors",
  {
    ns: text().notNull(),
    id: text().notNull(),
    knowledge: text().notNull(),
    doc: text().notNull(),
    valuesBlob: blob("values_blob").$type<ArrayBuffer | Uint8Array>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ns, table.id] }),
    index("vectors_corpus").on(table.ns, table.knowledge, table.id),
  ],
);

/** The typed schema fragment shared by vector-owning Durable Objects. */
export const vectorTables = { vectorIds, vectors };
