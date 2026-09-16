import * as z from "zod/mini";
import type { ScopeId } from "./context";
import { KarmiError } from "./errors";

/** The embedding configuration fixed when a Knowledge corpus first indexes vectors. */
export const embeddingIndexSchema = z.strictObject({
  model: z.string().check(z.minLength(1)),
  dims: z.int().check(z.gte(1), z.lte(65536)),
  metric: z.enum(["cosine", "dot-product", "euclidean"]),
});
/** The model, dimensions and distance metric of an embedding. */
export type EmbeddingIndex = z.output<typeof embeddingIndexSchema>;
/** Embeds text using one fixed model; implementations may call any provider. */
export interface Embedder extends EmbeddingIndex {
  /** Returns one finite vector per text, in input order. */
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}
/** A vector and the document that owns it. */
export interface VectorRow {
  id: string;
  values: Float32Array;
  metadata: { knowledge: string; doc: string };
}
/** Restricts vector search to a Knowledge corpus and optionally some documents. */
export interface VectorQuery {
  topK: number;
  knowledge: string;
  doc?: string[];
}
/** A ranked vector id; larger scores rank first for every metric. */
export interface VectorHit {
  id: string;
  score: number;
}
/** Stores vector mirrors under explicit Scope namespaces; mutations must be safe to retry. */
export interface VectorStore {
  upsert(ns: ScopeId, rows: VectorRow[]): Promise<void>;
  query(ns: ScopeId, vector: Float32Array, options: VectorQuery): Promise<VectorHit[]>;
  deleteByIds(ns: ScopeId, ids: string[]): Promise<void>;
  /** Clears only this Knowledge within the namespace, never another corpus. */
  deleteAll(ns: ScopeId, knowledge: string): Promise<void>;
}
/** Rejects invalid embeddings before any vector reaches storage. */
export function validateVector(vector: Float32Array, dims: number): void {
  if (vector.length !== dims || !vector.every(Number.isFinite))
    throw new KarmiError("knowledge.invalid", `Expected ${dims} finite embedding dimensions.`);
}
/** Rejects invalid query limits before executing a store query. */
export function validateVectorQuery(options: VectorQuery): void {
  if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100)
    throw new KarmiError("knowledge.invalid", "Vector topK must be an integer between 1 and 100.");
}
