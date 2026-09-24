import {
  defineAgent,
  defineVectorRetriever,
  KarmiError,
  VectorizeStore,
  type Embedder,
  type KnowledgeDocument,
  type VectorStore,
} from "@karmi/core";

/** The id of the vector retrieval scenario. It is also the id of its Agent. */
export const VECTORS = "vector-retrieval";

/** The corpus of the scenario. It has its own name, thus the Knowledge scenario keeps its full-text handbook. */
export const GUIDES = "guides";

/** The Catalogue name of the vector Retriever of the scenario. */
export const VECTOR_RETRIEVER = "semantic";

/** The search modes that the page compares. `keyword` is the default full-text Retriever, `fts5`. */
export const SEARCH_MODES = ["keyword", "vector", "hybrid"] as const;

/** One search mode of the page. */
export type SearchMode = (typeof SEARCH_MODES)[number];

/** The number of Passages that a search from the page returns. */
export const SEARCH_TOP_K = 3;

/** The search options that give one mode: a different Retriever for `keyword`, or the settings of the vector one. */
export const searchOptions = (mode: SearchMode) =>
  mode === "keyword" ? { retriever: "fts5" } : { settings: { mode, topK: SEARCH_TOP_K } };

/** The Workers AI binding and the Vectorize binding that the scenario needs. `pnpm deploy` adds both. */
export const VECTOR_BINDINGS = { ai: "KARMI_AI", index: "KNOWLEDGE_VECTORS" } as const;

/**
 * The dimensions and the metric of the default Workers AI embedding model, `@cf/baai/bge-m3`. The Vectorize index that
 * `pnpm deploy` creates has the same ones.
 */
export const INDEX_SHAPE = { dimensions: 1024, metric: "cosine" } as const;

/**
 * The external vector index of the scenario. The Retriever mirrors each vector to `store`. `ids` reads the index
 * around the Framework, thus the page can show what the index holds and can remove it to show a rebuild.
 */
export interface VectorIndex {
  /** The Vector store of the Retriever. */
  store: VectorStore;
  /** Returns the opaque ids of the vectors of one corpus in one Scope. It returns at most 100 ids. */
  ids(scope: string, knowledge: string): Promise<string[]>;
}

/**
 * Returns the external index on a Vectorize binding. `ids` queries the namespace of the Scope with a fixed vector and
 * a filter on the corpus, thus it finds each vector of a corpus with at most 100 vectors.
 */
export function vectorizeIndex(binding: Vectorize): VectorIndex {
  const probe = new Float32Array(INDEX_SHAPE.dimensions);
  probe[0] = 1;
  return {
    store: new VectorizeStore(binding, INDEX_SHAPE.metric),
    async ids(scope, knowledge) {
      const result = await binding.query(probe, {
        namespace: scope,
        topK: 100,
        returnValues: false,
        returnMetadata: "none",
        filter: { knowledge },
      });
      return result.matches.map((match) => match.id);
    },
  };
}

/**
 * Defines the vector Retriever of the scenario. It keeps each vector in the Knowledge Durable Object and mirrors it to
 * the external index. Its default mode is hybrid. `embedder` defaults to Workers AI through `KARMI_AI`. Without an
 * index, each operation fails with `bindings.missing`.
 */
export const semanticRetriever = (index: VectorIndex | undefined, embedder?: Embedder) =>
  defineVectorRetriever({
    name: VECTOR_RETRIEVER,
    mode: "hybrid",
    ...(embedder && { embedder }),
    store: () => {
      if (!index)
        throw new KarmiError("bindings.missing", `Vector retrieval needs the ${VECTOR_BINDINGS.index} binding.`);
      return index.store;
    },
  });

/** One document of the scenario, with the title that the page shows. */
export interface GuideDocument {
  id: string;
  title: string;
  text: string;
}

/** The guides of the sample Scope. The texts use few words of the suggested questions, thus a keyword search misses. */
export const STARTING_GUIDES: readonly GuideDocument[] = [
  {
    id: "returns",
    title: "Returns",
    text: "A customer can return an item within 30 days of the purchase. The shop refunds the price to the original payment card.",
  },
  {
    id: "allergens",
    title: "Allergens",
    text: "Each drink with oat, almond or soy milk gets an allergen label. The barista confirms the milk before the pour.",
  },
  {
    id: "storage",
    title: "Bean storage",
    text: "Store roasted beans in a sealed container away from light. They keep their flavour for four weeks.",
  },
  {
    id: "wifi",
    title: "Guest network",
    text: "The guest network is Coffee-Guest. The password is on each receipt.",
  },
  {
    id: "hours",
    title: "Opening hours",
    text: "The shop opens at 8:00 and closes at 18:00 from Monday to Saturday.",
  },
];

/**
 * The guides of the second sample Scope. The document has the same id as one of the first Scope and a different text,
 * thus a search shows that the two Scopes share no vector.
 */
export const OTHER_GUIDES: readonly GuideDocument[] = [
  {
    id: "returns",
    title: "Returns in the second Scope",
    text: "In the second sample Scope, a return needs the receipt, and the shop gives shop credit only.",
  },
];

/** The document as the Framework ingests it. The title goes in the metadata, which each Passage carries. */
export const toGuide = ({ id, title, text }: GuideDocument): KnowledgeDocument => ({ id, text, metadata: { title } });

/** The query that the search card starts with. No word of it is in a guide, thus only the vector search finds one. */
export const STARTING_QUERY = "get my money back";

/** The prompts that the scenario suggests. The operator can edit each one. */
export const VECTOR_PROMPTS = [
  { label: "Refund", text: "How do I get my money back?" },
  { label: "Fresh beans", text: "How long do beans stay fresh?" },
  { label: "Internet", text: "Where do I find internet access?" },
];

/**
 * Defines the Agent for the model that setup selected. The corpus reference names the vector Retriever with hybrid
 * settings, thus the `search_guides` Tool ranks by meaning and by words.
 */
export const vectorAgent = (model: string) =>
  defineAgent({
    agentId: VECTORS,
    name: "Shop guide",
    instructions: [
      {
        text: "You answer questions from the shop guides. Call search_guides with the question of the customer as it is, then answer in one sentence and name the id of the document that you used. When the search finds nothing, say that the guides have nothing about that.",
      },
    ],
    model: { id: model },
    knowledge: [
      { name: GUIDES, mode: "search", retriever: VECTOR_RETRIEVER, settings: { mode: "hybrid", topK: SEARCH_TOP_K } },
    ],
  });
