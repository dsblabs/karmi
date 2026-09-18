import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The typed query-builder view of the FTS5 Notes table created by the custom migration. */
export const notes = sqliteTable("notes", {
  id: integer("rowid").primaryKey(),
  text: text().notNull(),
  agentId: text("agent_id").notNull(),
  createdAt: integer("created_at").notNull(),
});
