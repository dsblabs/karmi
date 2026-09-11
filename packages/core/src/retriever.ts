import type { Logger, ScopeId } from "./context.js";
import { assertName } from "./names.js";
import type { Output, Schema } from "./schema.js";

export interface KnowledgeRef {
  scope: ScopeId;
  name: string;
}

export interface KnowledgeDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface Passage {
  docId: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RetrieverContext<Settings = undefined> {
  knowledge: KnowledgeRef;
  settings: Settings;
  logger: Logger;
  signal: AbortSignal;
}

export interface RetrieverInput<Settings extends Schema | undefined> {
  name: string;
  description?: string;
  settings?: Settings;
  search: (query: string, ctx: RetrieverContext<Output<Settings>>) => Promise<Passage[]>;
  index?: (docs: KnowledgeDocument[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  delete?: (docIds: string[], ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
  destroy?: (ctx: RetrieverContext<Output<Settings>>) => Promise<void>;
}

export interface Retriever<Settings extends Schema | undefined = Schema | undefined> extends Readonly<
  RetrieverInput<Settings>
> {
  readonly kind: "retriever";
}

export function defineRetriever<Settings extends Schema | undefined = undefined>(
  input: RetrieverInput<Settings>,
): Retriever<Settings> {
  assertName("retriever", input.name);
  return Object.freeze({ kind: "retriever", ...input });
}
