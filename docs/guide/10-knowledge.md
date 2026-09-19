---
title: Knowledge
---

# Knowledge

Knowledge is a named corpus of documents that belongs to one Scope. Each Agent of the Scope can use it. A Retriever finds the passages of the corpus that match a query.

## Bindings

Knowledge uses the `KARMI_KNOWLEDGE` Durable Object binding and the `karmi-v3` SQLite migration. The `create-karmi` template has them. For a Worker of your own, copy them from `wrangler.baseline.jsonc` in `@karmi/core`. [Getting started](01-getting-started.md) shows how the Worker exports `KnowledgeDO`.

## Ingest documents and give them to an Agent

`scope.knowledge(name)` opens a corpus. The first `ingest` creates it. This sample ingests one document and stores an Agent that can search the corpus:

```ts
import type { Scope } from "@karmi/core";

export async function setUpFaq(scope: Scope): Promise<void> {
  const faq = scope.knowledge("faq");
  await faq.ingest([{ id: "refunds", text: "Refunds are available within 30 days." }]);
  await scope.agents.put({
    agentId: "support",
    name: "Support",
    instructions: [{ text: "Answer from the company FAQ." }],
    model: { id: "anthropic/claude-sonnet-5" },
    knowledge: [{ name: "faq", mode: "search" }],
  });
}
```

A Knowledge name has 1 to 57 characters. The permitted characters are letters, digits, `_` and `-`. A document has an `id`, a `text` and optional JSON `metadata`.

The `mode` of a reference in the Agent Spec selects how the Agent gets the corpus:

| `mode`   | Effect                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------- |
| `search` | The Agent gets the read-only Tool `search_<name>`, for example `search_faq`. It is always loaded. |
| `tool`   | An alias of `search`.                                                                             |
| `inline` | The Harness puts the text of the full corpus in the prompt.                                       |

The `search_<name>` Tool obeys the explicit rules of the Permission Policy. With `inline`, the Turn fails if the text is longer than 32,000 Unicode code points. The exported constant `KNOWLEDGE_INLINE_LIMIT` holds this limit.

## The corpus API

| Method                    | Effect                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| `ingest(docs, options?)`  | Adds documents. A document with a known `id` replaces all of its old text. |
| `search(query, options?)` | Returns the ranked passages.                                               |
| `inline()`                | Returns the text of the full corpus. It throws above the inline limit.     |
| `delete(docIds)`          | Removes documents. You can repeat the call safely.                         |
| `rebuild()`               | Writes the saved vectors again to an external vector store.                |
| `destroy()`               | Removes the corpus and the data that its Retriever keeps.                  |
| `jobs.get(jobId)`         | Returns the progress of a bulk ingest.                                     |

`scope.knowledge.list()` returns the names of the ingested corpora.

This sample searches the corpus from code:

```ts
import type { Passage, Scope } from "@karmi/core";

export async function findRefundRules(scope: Scope): Promise<Passage[]> {
  return scope.knowledge("faq").search("How long do I have to return a product?");
}
```

A `Passage` has `docId`, `text`, `score` and optional `seq` and `metadata`. A higher `score` is a better match. `seq` is the position of the passage in its document. The default Retriever is `fts5Retriever`. It uses SQLite full-text search with BM25 ranking, returns a maximum of 10 passages and needs no external service.

### Options that the first ingest fixes

The first `ingest` fixes these options for the life of the corpus:

- `index.chunkSize`, which defaults to `2000` Unicode code points.
- `index.overlap`, which defaults to `200` Unicode code points.
- `index.embedding`, which is the embedding model, its dimensions and its metric.
- `retriever` and `settings`, which select the Retriever that indexes the corpus.

A later `ingest` with different values fails. To change them, call `destroy()` and ingest the documents again.

### Bulk ingest

A small `ingest` returns `{ indexed: count }`. An `ingest` of more than 32 documents, or of more than 64,000 UTF-16 code units, returns `{ pending: jobId }`. The Durable Object then indexes the documents in batches as a Job. This sample starts an ingest and reads the progress of its Job:

```ts
import type { KnowledgeDocument, KnowledgeJob, Scope } from "@karmi/core";

export async function importHandbook(scope: Scope, docs: KnowledgeDocument[]): Promise<KnowledgeJob | undefined> {
  const handbook = scope.knowledge("handbook");
  const result = await handbook.ingest(docs, { jobId: "handbook-import-2026-09" });
  if ("indexed" in result) return undefined;
  return handbook.jobs.get(result.pending);
}
```

- A `KnowledgeJob` has `state`, which is `pending` or `completed`, and the counts `completed` and `total`.
- Give a stable `jobId` when you can send the same request again. The second request returns the same Job. The same `jobId` with different documents fails.
- While a Job is pending, each other write fails with the code `knowledge.busy`. A search sees the documents that the Job has committed.
- A Tool that starts a bulk ingest passes `threadKey: thread.key` and returns the pending result. The Job then reports its completion to that Thread. [Tools](03-tools.md) describes pending results.

## Vector and hybrid retrieval

`vectorRetriever` ranks passages by embedding similarity. `hybridRetriever` combines the BM25 ranks and the vector ranks by reciprocal-rank fusion. Their Catalogue names are `vector` and `hybrid`. The two Retrievers keep the vectors in SQLite in the Knowledge Durable Object. They get `@cf/baai/bge-m3` embeddings from Workers AI through the `KARMI_AI` binding.

This sample registers the two Retrievers, ingests with `vector` and searches in hybrid mode:

```ts
import { createKarmi, hybridRetriever, vectorRetriever, type Passage } from "@karmi/core";

export const karmi = createKarmi({ catalogue: { retrievers: [vectorRetriever, hybridRetriever] } });

export async function searchHandbook(query: string): Promise<Passage[]> {
  const handbook = karmi.scope("acme").knowledge("handbook");
  await handbook.ingest([{ id: "refunds", text: "Refunds are available within thirty days." }], {
    retriever: "vector",
  });
  return handbook.search(query, { settings: { mode: "hybrid", topK: 10 } });
}
```

A search uses the Retriever of the first ingest unless you pass `retriever`. The settings of a vector Retriever are `mode`, which is `vector` or `hybrid`, and `topK`, which is 1 to 100 and defaults to 10. An Agent Spec can pass the same values, for example `{ name: "handbook", retriever: "hybrid", settings: { topK: 5 } }`.

The first ingest also fixes the embedding model, the dimensions and the metric. To use a different model, create a new corpus. Memory recall always uses full-text search.

### A vector Retriever of your own

`defineVectorRetriever` makes a vector Retriever with your options:

| Option         | Default             | Meaning                                                  |
| -------------- | ------------------- | -------------------------------------------------------- |
| `name`         | Required            | The Catalogue name.                                      |
| `mode`         | `vector`            | The default search mode.                                 |
| `embedder`     | Workers AI `bge-m3` | An `Embedder` that calls your embedding provider.        |
| `store`        | SQLite              | A function that returns a `VectorStore` for the context. |
| `maxChunks`    | `1000`              | The number of vectors that one SQLite page read returns. |
| `rankConstant` | `60`                | The constant of the reciprocal-rank fusion.              |

The SQLite store reads a large corpus in pages and keeps a maximum of 100 ranked results.

### Cloudflare Vectorize

`VectorizeStore` keeps the vectors in a Vectorize index. Use one index for each Deployment and embedding model, and the same binding for every Scope. The store adds the Scope as the namespace and hashes the ids. Thus equal ids in two Scopes do not collide. This sample defines a Retriever on a Vectorize binding:

```ts
import { defineVectorRetriever, VectorizeStore } from "@karmi/core";
import { env } from "cloudflare:workers";

export const searchRetriever = defineVectorRetriever({
  name: "search",
  store: (ctx) => new VectorizeStore(env.KNOWLEDGE_VECTORS_BGE_M3, ctx.embedding?.metric),
});
```

The metric of the store defaults to `cosine`. It must be the same as the metric of the index.

Create the index and its two string metadata indexes before the first ingest:

```sh
pnpm exec wrangler vectorize create karmi-bge-m3 --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index karmi-bge-m3 --property-name=knowledge --type=string
pnpm exec wrangler vectorize create-metadata-index karmi-bge-m3 --property-name=doc --type=string
```

Bind the index in `wrangler.jsonc`. Then set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` and check the bound index:

```sh
pnpm exec karmi doctor --config wrangler.jsonc --binding KNOWLEDGE_VECTORS_BGE_M3 --dims 1024 --metric cosine
```

The check only reads the index. It never creates or changes it. [karmi doctor](15-doctor.md) describes the other checks.

The Knowledge Durable Object saves each embedding before it writes to Vectorize. `rebuild()` writes the saved vectors again and does not call the embedding model. Vectorize applies writes asynchronously. Thus a search can miss a document for a short time after `ingest` returns.

## A custom Retriever

`defineRetriever` makes a Retriever that uses a search service of your own. `search` is required. `index`, `delete`, `rebuild` and `destroy` are optional. This sample sends the chunks and the queries to an external service:

```ts
import { createKarmi, defineRetriever, type Passage } from "@karmi/core";

const searchUrl = "https://search.example.com";

export const ordersRetriever = defineRetriever({
  name: "orders-search",
  async index(chunks, ctx) {
    await fetch(`${searchUrl}/${ctx.knowledge.scope}/${ctx.knowledge.name}`, {
      method: "PUT",
      body: JSON.stringify(chunks),
      signal: ctx.signal,
    });
  },
  async search(query, ctx): Promise<Passage[]> {
    const url = `${searchUrl}/${ctx.knowledge.scope}/${ctx.knowledge.name}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: ctx.signal });
    if (!response.ok) return ctx.search(query);
    return response.json();
  },
});

export const karmi = createKarmi({ catalogue: { retrievers: [ordersRetriever] } });
```

- `index` gets the chunks that the Framework makes. The pair `id` and `seq` identifies a chunk.
- Each function gets a `RetrieverContext`. It has the Scope and the name of the corpus, the parsed `settings`, a `logger` and an abort `signal`.
- `ctx.search(query, topK?)` runs the local full-text search. `ctx.inline()` returns the full corpus below the inline limit.
- A `settings` schema on the Retriever validates the `settings` of an Agent Spec reference.
- `index`, `delete` and `destroy` must be idempotent. After a failure, the Framework can call one of them again with the same input.
