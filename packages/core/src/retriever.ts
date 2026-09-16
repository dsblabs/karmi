import type { EmbeddingIndex } from "./vector-store";
import type * as z from "zod/mini";
import type { knowledgeDocumentsSchema, KnowledgeChunk } from "./knowledge";
import type { Logger, ScopeId } from "./context";
import { assertName } from "./names";
import type { Output, Schema } from "./schema";

/** The Knowledge a Retriever operation works on. */
export interface KnowledgeRef {
  scope: ScopeId;
  name: string;
}

/** One document to index into Knowledge. */
export type KnowledgeDocument = z.output<typeof knowledgeDocumentsSchema>[number];

/** One search hit, a piece of a document with its relevance score. */
export interface Passage {
  /** The ranking method used by built-in vector Retrievers. */
  source?: "fts" | "vector" | "hybrid";
  docId: string;
  text: string;
  score: number;
  /** The chunk sequence within its document, when supplied by the Retriever. */
  seq?: number;
  metadata?: Record<string, unknown>;
}

/** What every Retriever operation receives. */
export interface RetrieverContext<Settings = undefined> {
  knowledge: KnowledgeRef;
  /** Searches the committed chunk ledger with FTS5 BM25. */
  search(query: string, topK?: number): Passage[];
  /** The Knowledge ledger storage, available to vector Retrievers. */
  storage: SqlStorage;
  /** The embedding configuration fixed at first ingest. */
  embedding?: EmbeddingIndex;
  /** The optional Workers AI binding for the default Embedder. */
  ai?: Ai;
  /** Reads the complete corpus, enforcing the Framework inline limit. */
  inline(): string;
  /** The per-reference `settings` from the Agent Spec, validated against the Retriever's schema. */
  settings: Settings;
  logger: Logger;
  signal: AbortSignal;
}

/** The definition `defineRetriever` takes. */
export interface RetrieverInput<Settings extends Schema | undefined> {
  name: string;
  /** The embedding configuration this Retriever requires. */
  embedding?: EmbeddingIndex;
  description?: string;
  /** The schema of the per-reference `settings` an Agent Spec may pass. */
  settings?: Settings;
  /** Finds the passages that match a query. */
  search: (query: string, ctx: RetrieverContext<Output<Settings>>) => Promise<Passage[]>;
  /** Adds documents, replacing any with the same id. */
  index?: (docs: KnowledgeChunk[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  /** Removes the documents with these ids. */
  delete?: (docIds: string[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  /** Rebuilds an external mirror from the committed ledger without re-embedding. */
  rebuild?: (ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  /** Removes everything stored for the Knowledge. */
  destroy?: (ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
}

/** A Retriever as `defineRetriever` returns it. */
export interface Retriever<Settings extends Schema | undefined = Schema | undefined> extends Readonly<
  RetrieverInput<Settings>
> {
  readonly kind: "retriever";
}

/** Defines a Retriever for the Catalogue. Throws a `KarmiError` when the name is invalid. */
export function defineRetriever<Settings extends Schema | undefined = undefined>(
  input: RetrieverInput<Settings>,
): Retriever<Settings> {
  assertName("retriever", input.name);
  return Object.freeze({ kind: "retriever", ...input });
}

/** The explicit context supplied to every Retriever operation. */
export type RetrieverCtx<Settings = undefined> = RetrieverContext<Settings>;

/** The default Retriever, using the ledger's transactionally maintained FTS5 index. */
export const fts5Retriever = defineRetriever({
  name: "fts5",
  search: async (query, ctx) => ctx.search(query),
  index: async () => {},
  delete: async () => {},
  destroy: async () => {},
});
