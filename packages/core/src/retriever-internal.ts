import type { KnowledgeDatabase } from "./knowledge-store";
import type { RetrieverContext } from "./retriever";

const databases = new WeakMap<RetrieverContext<unknown>, KnowledgeDatabase>();

/** Associates an internal Drizzle database with a Retriever context without changing its public shape. */
export function attachRetrieverDatabase<T>(context: RetrieverContext<T>, db: KnowledgeDatabase): RetrieverContext<T> {
  databases.set(context as RetrieverContext<unknown>, db);
  return context;
}

/** Returns the internal Drizzle database for a built-in Retriever. */
export function retrieverDatabase(context: RetrieverContext<unknown>): KnowledgeDatabase {
  const db = databases.get(context);
  if (!db) throw new Error("The built-in Retriever requires a Knowledge database context.");
  return db;
}
