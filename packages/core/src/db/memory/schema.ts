import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { vectorIds, vectors, vectorTables } from "../vector-schema";

export { vectorIds, vectors };

/** This table stores the identity and structured Profile of one User's Memory. */
export const memoryHead = sqliteTable("memory_head", {
  scopeId: text("scope_id").notNull(),
  userId: text("user_id").notNull(),
  profile: text("profile_json", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** The complete relational schema of the Memory Durable Object. */
export const memorySchema = { memoryHead, ...vectorTables };
