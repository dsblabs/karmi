import { fuseRanks } from "./vector-ranking";
import type { KnowledgeChunk } from "./knowledge";
import * as z from "zod/mini";
import { KarmiError } from "./errors";
import { defaultEmbeddingIndex, workersAiEmbedder } from "./embedder";
import { defineRetriever, type RetrieverContext } from "./retriever";
import { VectorLedger } from "./vector-ledger";
import { retrieverDatabase } from "./retriever-internal";
import {
  embeddingIndexSchema,
  validateVector,
  type Embedder,
  type EmbeddingIndex,
  type VectorStore,
} from "./vector-store";

function settingsSchema(mode: "vector" | "hybrid") {
  return z.strictObject({
    mode: z._default(z.enum(["vector", "hybrid"]), mode),
    topK: z._default(z.int().check(z.gte(1), z.lte(100)), 10),
  });
}
type Settings = z.output<ReturnType<typeof settingsSchema>>;
/** Configures a Catalogue Retriever with SQLite by default and an optional external vector mirror. */
export interface VectorRetrieverOptions {
  name: string;
  /** The default search mode; defaults to vector. */
  mode?: "vector" | "hybrid";
  /** Defaults to Workers AI bge-m3 through KARMI_AI. */
  embedder?: Embedder;
  /** Defaults to the SQLite ledger in the Knowledge Durable Object. */
  store?: (ctx: RetrieverContext<Settings>) => VectorStore;
  /** The maximum vectors read per SQLite page; defaults to 1000. */
  maxChunks?: number;
  /** The reciprocal-rank constant for hybrid fusion; defaults to 60. */
  rankConstant?: number;
}
/** Defines a vector Retriever; search settings may select hybrid BM25 and vector ranking. */
export function defineVectorRetriever(options: VectorRetrieverOptions) {
  const rankConstant = options.rankConstant ?? 60;
  if (!Number.isFinite(rankConstant) || rankConstant < 0)
    throw new KarmiError("knowledge.invalid", "rankConstant must be finite and nonnegative.");
  const embedding = z.parse(
    embeddingIndexSchema,
    options.embedder
      ? { model: options.embedder.model, dims: options.embedder.dims, metric: options.embedder.metric }
      : defaultEmbeddingIndex,
  );
  return defineRetriever({
    name: options.name,
    embedding,
    settings: settingsSchema(options.mode ?? "vector"),
    index: (chunks, ctx) => indexChunks(chunks, ctx, options, embedding),
    async search(query, ctx) {
      const { ledger, store } = resources(options, embedding, ctx);
      const values = await embedder(options, ctx).embed([query], "query");
      const vector = values[0];
      if (values.length !== 1 || !vector) throw new KarmiError("knowledge.invalid", "Expected one query embedding.");
      validateVector(vector, embedding.dims);
      const hits = await store.query(ctx.knowledge.scope, vector, {
        knowledge: ctx.knowledge.name,
        topK: Math.min(100, ctx.settings.topK * (ctx.settings.mode === "hybrid" ? 3 : 1)),
      });
      const passages = ledger.passages(hits);
      if (ctx.settings.mode === "hybrid")
        return fuseRanks(ctx.search(query, ctx.settings.topK * 3), passages, rankConstant).slice(0, ctx.settings.topK);
      return passages.map((hit) => ({ ...hit, source: "vector" as const }));
    },
    async delete(docs, ctx) {
      const { ledger, store } = resources(options, embedding, ctx);
      for (const doc of docs) {
        for (const ids of ledger.idBatches(doc)) {
          await store.deleteByIds(ctx.knowledge.scope, ids);
          await ledger.remove(ids);
        }
      }
    },
    async destroy(ctx) {
      const { ledger, store } = resources(options, embedding, ctx);
      for (const ids of ledger.idBatches()) {
        await store.deleteByIds(ctx.knowledge.scope, ids);
        await ledger.remove(ids);
      }
    },
    async rebuild(ctx) {
      const { ledger, store } = resources(options, embedding, ctx);
      for (const batch of ledger.batches()) await store.upsert(ctx.knowledge.scope, batch);
    },
  });
}

function resources(options: VectorRetrieverOptions, embedding: EmbeddingIndex, ctx: RetrieverContext<Settings>) {
  if (
    !ctx.embedding ||
    ctx.embedding.model !== embedding.model ||
    ctx.embedding.dims !== embedding.dims ||
    ctx.embedding.metric !== embedding.metric
  )
    throw new KarmiError(
      "knowledge.indexConflict",
      "The Retriever embedding model, dimensions or metric differ from this Knowledge index.",
    );
  const ledger = new VectorLedger(retrieverDatabase(ctx), ctx.knowledge, embedding, options.maxChunks);
  return { ledger, store: options.store?.(ctx) ?? ledger.local };
}
function embedder(options: VectorRetrieverOptions, ctx: RetrieverContext<Settings>): Embedder {
  if (options.embedder) return options.embedder;
  if (!ctx.ai) throw new KarmiError("bindings.missing", "Vector retrieval needs KARMI_AI or an explicit Embedder.");
  return workersAiEmbedder(ctx.ai);
}

async function indexChunks(
  chunks: KnowledgeChunk[],
  ctx: RetrieverContext<Settings>,
  options: VectorRetrieverOptions,
  embedding: EmbeddingIndex,
): Promise<void> {
  const { ledger, store } = resources(options, embedding, ctx);
  for (let offset = 0; offset < chunks.length; offset += 100) {
    const batch = chunks.slice(offset, offset + 100);
    const values = await embedder(options, ctx).embed(
      batch.map((chunk) => chunk.text),
      "document",
    );
    if (values.length !== batch.length)
      throw new KarmiError("knowledge.invalid", "Embedding response count differs from chunk count.");
    for (const value of values) validateVector(value, embedding.dims);
    const rows = await ledger.put(batch, values);
    if (store !== ledger.local) await store.upsert(ctx.knowledge.scope, rows);
  }
}

/** A Catalogue Retriever using Workers AI embeddings and the SQLite vector store. */
export const vectorRetriever = defineVectorRetriever({ name: "vector" });
/** A Catalogue Retriever combining BM25 and vector ranks with reciprocal-rank fusion. */
export const hybridRetriever = defineVectorRetriever({ name: "hybrid", mode: "hybrid" });
