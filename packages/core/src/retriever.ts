import type { Logger, ScopeId } from "./context";
import { assertName } from "./names";
import type { Output, Schema } from "./schema";

/** The Knowledge a Retriever operation works on. */
export interface KnowledgeRef {
  scope: ScopeId;
  name: string;
}

/** One document to index into Knowledge. */
export interface KnowledgeDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** One search hit, a piece of a document with its relevance score. */
export interface Passage {
  docId: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** What every Retriever operation receives. */
export interface RetrieverContext<Settings = undefined> {
  knowledge: KnowledgeRef;
  /** The per-reference `settings` from the Agent Spec, validated against the Retriever's schema. */
  settings: Settings;
  logger: Logger;
  signal: AbortSignal;
}

/** The definition `defineRetriever` takes. */
export interface RetrieverInput<Settings extends Schema | undefined> {
  name: string;
  description?: string;
  /** The schema of the per-reference `settings` an Agent Spec may pass. */
  settings?: Settings;
  /** Finds the passages that match a query. */
  search: (query: string, ctx: RetrieverContext<Output<Settings>>) => Promise<Passage[]>;
  /** Adds documents, replacing any with the same id. */
  index?: (docs: KnowledgeDocument[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  /** Removes the documents with these ids. */
  delete?: (docIds: string[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
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
