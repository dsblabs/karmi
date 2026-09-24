// This module has no import, thus the Worker and the Node deploy command can both import it.

/** The Workers AI binding and the Vectorize binding of the vector retrieval scenario. `pnpm run deploy` adds both. */
export const VECTOR_BINDINGS = { ai: "KARMI_AI", index: "KNOWLEDGE_VECTORS" } as const;

/**
 * The shape of the Vectorize index: the dimensions and the metric of the default Workers AI embedding model,
 * `@cf/baai/bge-m3`. `pnpm run deploy` creates the index with it and refuses a supplied index with a different one.
 */
export const INDEX_SHAPE = { dimensions: 1024, metric: "cosine" } as const;

/** The metadata properties that the Framework filters on. The index needs a string metadata index for each one. */
export const INDEX_METADATA = ["knowledge", "doc"] as const;
