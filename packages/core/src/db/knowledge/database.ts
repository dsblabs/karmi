import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { knowledgeSchema } from "./schema";

/** The typed database shared by internal Knowledge storage helpers. */
export type KnowledgeDatabase = DrizzleSqliteDODatabase<typeof knowledgeSchema>;

/** Opens the Knowledge database adapter over raw storage supplied to a public Retriever. */
export function openKnowledgeDatabase(storage: SqlStorage): KnowledgeDatabase {
  // Drizzle's adapter requires a DurableObjectStorage even though its queries use only the supplied `sql` client.
  const client = { sql: storage } as DurableObjectStorage;
  return drizzle(client, { schema: knowledgeSchema });
}
