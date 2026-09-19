import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { knowledgeSchema } from "./schema";

/** The typed database shared by internal Knowledge storage helpers. */
export type KnowledgeDatabase = DrizzleSqliteDODatabase<typeof knowledgeSchema>;

/** Opens the internal Knowledge database adapter over Durable Object SQL storage. */
export function openKnowledgeDatabase(storage: SqlStorage): KnowledgeDatabase {
  // Drizzle's adapter requires a DurableObjectStorage even though its queries use only the supplied `sql` client.
  const client = { sql: storage } as DurableObjectStorage;
  return drizzle(client, { schema: knowledgeSchema });
}
