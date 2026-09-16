import * as z from "zod/mini";
import type { KarmiBindings } from "./bindings";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import type { KnowledgeDurableObject } from "./knowledge-do";
import { remote, unwrap } from "./outcome";
import type { KnowledgeDocument, Passage } from "./retriever";
import type { ToolPending } from "./tool";

/** The immutable chunking configuration, measured in Unicode code points. */
export const knowledgeIndexSchema = z
  .strictObject({
    /** The largest chunk, in Unicode code points; defaults to 2000. */
    chunkSize: z._default(z.int().check(z.gte(1), z.lte(16000)), 2000),
    /** The shared suffix and prefix of adjacent chunks; defaults to 200. */
    overlap: z._default(z.int().check(z.gte(0)), 200),
  })
  .check(z.refine((value) => value.overlap < value.chunkSize, "overlap must be smaller than chunkSize"));
/** The chunking configuration fixed by the first ingest. */
export type KnowledgeIndex = z.output<typeof knowledgeIndexSchema>;
/** The documents accepted by ingest and decoded again when a bulk Job resumes. */
export const knowledgeDocumentsSchema = z.array(
  z.strictObject({
    id: z.string().check(z.minLength(1), z.maxLength(512)),
    text: z.string(),
    metadata: z.optional(z.record(z.string(), z.json())),
  }),
);
/** The options of an ingest, including an optional Thread Job callback. */
export const knowledgeIngestSchema = z.strictObject({
  /** The chunking options, fixed on first ingest. */
  index: z.optional(knowledgeIndexSchema),
  /** The indexing Retriever name, fixed on first ingest; defaults to fts5. */
  retriever: z.optional(z.string()),
  /** The indexing Retriever settings, fixed on first ingest. */
  settings: z.optional(z.record(z.string(), z.json())),
  /** A stable id for retrying the same request; defaults to a generated id. */
  jobId: z.optional(z.string().check(z.minLength(1), z.maxLength(128))),
  /** The originating Thread key when a Tool returns the pending Job. */
  threadKey: z.optional(z.string()),
});
/** The options of an ingest; a repeated jobId resumes the same request. */
export type KnowledgeIngestOptions = z.input<typeof knowledgeIngestSchema>;
/** The saved progress of a bulk ingest. */
export type KnowledgeJob = { state: "pending" | "completed"; completed: number; total: number };
/** The maximum text length admitted into one inline Knowledge Fragment. */
export const KNOWLEDGE_INLINE_LIMIT = 32000;
/** Ingests above this many UTF-16 code units run as durable Jobs. */
export const KNOWLEDGE_BULK_THRESHOLD = 64000;

/** A named corpus in a Scope; ingest replaces documents by id and search returns ranked chunks. */
export interface Knowledge {
  /** Fixes chunking on first ingest; large requests return a durable pending Job. */
  ingest(docs: KnowledgeDocument[], options?: KnowledgeIngestOptions): Promise<{ indexed: number } | ToolPending>;
  /** Searches using FTS5 by default, or a Catalogue Retriever. */
  search(query: string, options?: { retriever?: string; settings?: Record<string, unknown> }): Promise<Passage[]>;
  /** Reads the whole corpus, failing when it exceeds the inline limit. */
  inline(): Promise<string>;
  /** Deletes documents by id; repeating a deletion is safe. */
  delete(docIds: string[]): Promise<void>;
  /** Clears the corpus and its mirrors; rejects while ingest or its Thread callback is pending. */
  destroy(): Promise<void>;
  /** Reads the durable progress of a pending ingest. */
  jobs: { get(jobId: string): Promise<KnowledgeJob> };
}

/** Opens a Knowledge handle, failing if its namespace is not bound. */
export function openKnowledge(bindings: KarmiBindings, scope: string, name: string): Knowledge {
  if (!bindings.KARMI_KNOWLEDGE)
    throw new KarmiError("bindings.missing", "Knowledge needs KARMI_KNOWLEDGE bound to KnowledgeDO.");
  const stub = remote<KnowledgeDurableObject>(bindings.KARMI_KNOWLEDGE, keys.knowledge(scope, name));
  return {
    ingest: (docs, options = {}) => unwrap(stub.ingest(scope, name, docs, options)),
    search: (query, options = {}) => unwrap(stub.search(scope, name, query, options)),
    inline: () => unwrap(stub.inline(scope, name)),
    delete: (ids) => unwrap(stub.remove(scope, name, ids)),
    destroy: () => unwrap(stub.destroy(scope, name)),
    jobs: { get: (id) => unwrap(stub.job(scope, name, id)) },
  };
}

/** Splits a document without cutting surrogate pairs, preserving its id and metadata. */
export function chunkDocument(doc: KnowledgeDocument, index: KnowledgeIndex): KnowledgeChunk[] {
  const points = Array.from(doc.text);
  const chunks: KnowledgeChunk[] = [];
  for (let start = 0; start < points.length; start += index.chunkSize - index.overlap) {
    chunks.push({ ...doc, seq: chunks.length, text: points.slice(start, start + index.chunkSize).join("") });
    if (start + index.chunkSize >= points.length) break;
  }
  return chunks;
}
/** One Framework-produced chunk, identified by its document id and zero-based sequence. */
export interface KnowledgeChunk extends KnowledgeDocument {
  seq: number;
}
