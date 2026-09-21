import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { threadSchema } from "./schema";

/** The typed database shared by the Thread Durable Object and its storage modules. */
export type ThreadDatabase = DrizzleSqliteDODatabase<typeof threadSchema>;

/** Opens the Thread database adapter over Durable Object SQL storage. It runs no migration. */
export function openThreadDatabase(storage: SqlStorage): ThreadDatabase {
  // Drizzle's adapter requires a DurableObjectStorage even though its queries use only the supplied `sql` client.
  const client = { sql: storage } as DurableObjectStorage;
  return drizzle(client, { schema: threadSchema });
}
