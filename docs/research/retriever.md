# Vector Retriever on Cloudflare: Vectorize, AI Search, or bring-your-own

Research note, 2026-08-30, answering GitHub issue #22 (child of map #1). Primary sources only: developers.cloudflare.com (Vectorize, AI Search, Durable Objects, Workers, Workers AI, AI Gateway, Hyperdrive, local-development and Vitest pages, product changelogs, the REST API reference), the `cloudflare/workerd` repository (`main`, commit `e9dda59`, 2026-08-30; shallow clone in `/tmp`), the `cloudflare/workers-sdk` repository (`main`, commit `f808554`, 2026-08-28), the `cloudflare/cloudflare-docs` model JSON files read via the GitHub API, sqlite.org, platform.claude.com, developers.openai.com, ai.google.dev, ai-sdk.dev, docs.voyageai.com, turbopuffer.com, docs.pinecone.io, qdrant.tech, upstash.com, and the `asg017/sqlite-vec` README. Every claim carries a bracket key from section 9; anything not verifiable from a primary source is marked UNVERIFIED. Glossary (Scope, Knowledge, Retriever, Memory, Catalogue, Agent Spec, Job, Capability, Spill) follows `CONTEXT.md`; prior decisions are cited as [ADR-1] (name-based Scope isolation), [ADR-2] (compatibility baseline), [RC] (runtime comparison), [PS] (provider seam) and [P7]/[P14] (issues #7 and #14 resolutions).

Date-sensitive: AI Search (renamed from AutoRAG on **2025-09-25**) is still "open beta", free "within these limits", with pricing promised "at least 30 days before any billing begins" (limits page last updated 2026-08-26) [AIS-limits][AIS-release]; its `ai_search_namespaces` binding, built-in storage, runtime `create()`/`delete()` of instances and hybrid BM25+vector search all landed on **2026-04-16** [AIS-cl-ns][AIS-cl-hybrid][AIS-blog]. Vectorize has been GA since 2024-09-26 (V2 engine; V1 deprecated 2024-08-14), with the limits page last updated 2026-08-05 [VEC-changelog][VEC-limits]. The Vitest integration package on the docs is now `@cloudflare/vitest-plugin` 1.1.2 (2026-08-28) with `remoteBindings` defaulting to `true`; `@cloudflare/vitest-pool-workers` 0.22.0 (2026-08-18) still publishes, and `workers-sdk` `main` carries only `packages/vitest-plugin` [W-dev][VP-npm][VP-src] — the rename is UNVERIFIED beyond that evidence and [ADR-2] should follow it.

## 1. Summary and recommendation

**Recommendation: the v0 reference vector Retriever is a Vectorize adapter — one Vectorize index per Deployment per embedding model, a namespace per Scope, hashed vector ids, and a chunk ledger in the Knowledge's own Durable Object — shipped beside a DO-SQLite brute-force adapter that is the local/test implementation and the small-corpus default. AI Search and bring-your-own stores are adapters behind the same seam, not the reference. FTS5 is confirmed in DO SQLite and stays the shipped default.** Concretely:

1. **FTS5 is real.** workerd compiles SQLite 3.53.4 with `SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_RTREE`, `SQLITE_ENABLE_MATH_FUNCTIONS`, and its authorizer allows exactly four virtual-table modules — `fts5`, `fts5vocab`, `rtree`, `rtree_i32` — and nothing else; `load_extension` is not in the allowed-function list, so `sqlite-vec`/`sqlite-vss` (loadable extensions providing `vec0`) cannot exist in DO SQLite [workerd-build][workerd-vtab][workerd-funcs][sqlite-vec]. The docs page says the same ("FTS5 module for full-text search, JSON extension, math functions") [DO-sql]. Miniflare runs the same workerd binary, so local tests get FTS5 too [MF-readme]. Limits: 10 GB per DO, 2 MB per row/blob, 100 KB per statement, 100 bound parameters, 100 columns, 30 s CPU per request (configurable to 5 min), 128 MB memory per isolate shared by co-located DOs [DO-limits][W-limits][DO-mem].
2. **Vectorize fits [ADR-1]'s name-based isolation.** Namespaces (64 bytes, 50,000 per index on Paid / 1,000 on Free) are set per vector and filter *before* the ANN search; a ScopeId is `[A-Za-z0-9_-]{1,64}` so `namespace = scopeId` fits without hashing [VEC-limits][VEC-insert][ADR-1]. Indexes are static wrangler bindings (or REST), created out of band with immutable `dimensions`/`metric`; a Deployment therefore owns one index per embedding model and Scopes never create indexes [VEC-create][VEC-api]. There is **no delete-by-namespace** — only `deleteByIds` and a paginated `list` of *all* ids — so `scope.destroy()` needs the Framework's own ledger of ids [VEC-api][VEC-list]. Writes are asynchronous (`mutationId`), batched into jobs of ≤200,000 vectors / ≤1,000 updates; 250k single-row inserts "could take an hour", 100 batches of 2,500 "minutes" [VEC-insert]. Pricing is dimensions-based: 50 M queried + 10 M stored dimensions/month included on Paid, then $0.01/M queried and $0.05/100 M stored; on Free 30 M queried / 5 M stored [VEC-pricing]. No local emulation: Miniflare's Vectorize plugin is a remote proxy only, and the docs list Vectorize among bindings with "no current local simulation" [MF-vec][W-dev].
3. **AI Search is a product, not a store.** Since 2026-04-16 a Worker can `env.AI_SEARCH.create({ id, embedding_model, index_method: { vector, keyword }, chunk_size, chunk_overlap, sync_interval })`, upload with `instance.items.uploadAndPoll()`, `search()` without generation (`retrieval_type: "vector" | "keyword" | "hybrid"`, RRF or max fusion, optional `@cf/baai/bge-reranker-base`), and `delete()` the instance "and all its data" — the per-tenant recipe Cloudflare itself documents [AIS-binding-inst][AIS-binding][AIS-tenant][AIS-hybrid]. But instances are capped at **5,000 per account** on Paid (100 Free), with 100 namespaces per account, 4 MB per file, embedding model fixed at creation, no local runtime (`remote: true` required), open-beta pricing unknown, and Cloudflare owning chunking [AIS-limits][AIS-models][AIS-tenant][AIS-chunk]. Knowledge is keyed (Scope, name) and Scopes "may number in the tens of thousands" [P7][ADR-1]; an instance per Knowledge cannot be the reference. It is a good *optional* adapter for a Platform that wants managed crawling and conversion of PDFs/Office files [AIS-sources].
4. **Embeddings default to `@cf/baai/bge-m3`** (1,024 dims, multilingual, $0.012/M input tokens = 1,075 neurons/M, batch of ≤100 texts per call, 3,000 requests/min) through the Workers AI binding, with the provider seam [PS] offering OpenAI `text-embedding-3-small` (1,536 dims, $0.02/M), Voyage `voyage-4-lite`/`voyage-4` (1,024 dims, $0.02/$0.06 per M, Anthropic's documented recommendation) and Google `gemini-embedding-2` (128–3,072 dims, $0.20/M) [WAI-pricing][WAI-models][WAI-limits][AIS-models][OA-emb][OA-pricing][AN-emb][VO-pricing][GG-emb][GG-pricing]. The embedding model, its dimensions and metric are a **Knowledge-level fact** recorded at first ingest (Vectorize index config is immutable; changing the model means a new index and a full re-embed); the Scope only supplies a *default* for new Knowledge [VEC-create].
5. **Hybrid (FTS5 BM25 + vector, reciprocal-rank fusion) is cheap** because both halves return ranked chunk ids and the ledger already holds the text: FTS5's `bm25()`/`rank` gives the lexical list inside the Knowledge DO, the vector adapter gives the other, and fusion is twenty lines with no extra storage [FTS5][AIS-hybrid]. Ship it as `mode: "hybrid"` on the Retriever, off by default.

What stays out of v0: AI Search and BYO adapters (interface only), reranking, Memory recall over vectors (Memory stays FTS5 — Vectorize's asynchronous visibility is wrong for "remember then recall in the same Turn"), image/multimodal embeddings, per-Scope Vectorize indexes, data-residency for vectors.

## 2. DO SQLite and FTS5

| Question | Finding | Source |
|---|---|---|
| FTS5 compiled in | `build/BUILD.sqlite3` defines `SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_RTREE`, `SQLITE_ENABLE_MATH_FUNCTIONS`, `SQLITE_ENABLE_NORMALIZE`, `SQLITE_DEFAULT_FOREIGN_KEYS=1`, `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, `SQLITE_MAX_ALLOCATION_SIZE=16777216`; SQLite source is `sqlite-src-3530400` (3.53.4) | [workerd-build][workerd-module] |
| Virtual tables allowed | Authorizer `SQLITE_CREATE_VTABLE`: "We don't support these except for" `fts5`, `fts5vocab`, `rtree`, `rtree_i32`; `ATTACH`/`DETACH` never; temp tables never | [workerd-vtab] |
| Vector extensions | `sqlite-vec` is a loadable extension exposing a `vec0` virtual table, "pre-v1, so expect breaking changes" [sqlite-vec]; workerd's function allowlist lists `load_extension` only to *name* it among SQLite built-ins that pass the authorizer, and `vec0` is not in the vtable allowlist, so no vector extension is reachable. Cloudflare docs list only FTS5, JSON and math functions as supported extensions | [workerd-funcs][workerd-vtab][DO-sql] |
| Docs statement | "supports three SQLite extensions: FTS5 module for full-text search, JSON extension, Math functions"; no `BEGIN`/`SAVEPOINT` through `sql.exec` (use `transactionSync`) | [DO-sql] |
| Local emulation | Miniflare "runs the same workerd binary"; the Vitest integration runs tests inside workerd [RC §3]; therefore FTS5 is identical locally | [MF-readme][RC] |
| Size limits | 10 GB per DO (Paid account unlimited, Free 5 GB); max statement 100 KB; max 100 bound parameters; max 100 columns; max 2 MB per string/BLOB/row; rows per table unlimited within the 10 GB; `databaseSize` property | [DO-limits][DO-sql] |
| Compute limits | 30 s CPU per request, configurable to 5 min; HTTP/RPC wall clock unlimited while the caller is connected; alarms 15 min; 128 MB memory per *isolate*, and "Durable Objects may run in the same isolate on the same physical machine and share the 128 MB" | [DO-limits][W-limits][DO-mem] |
| `sql.exec` cursor | Returns `SqlStorageCursor` (Iterable/Iterator; `toArray()`, `one()`, `raw()`, `next()`, `columnNames`, `rowsRead`, `rowsWritten`); **no snapshot isolation across `await`** — "a cursor resumed after an await may observe rows inserted, updated, or deleted after the cursor was created"; bindings apply only to the last of `;`-separated statements | [DO-sql] |
| BLOB binding | `SqlStorageValue = ArrayBuffer \| string \| number \| null`; `kj::Array<const byte>` is a binding type | [workerd-sql-h] |
| FTS5 features | `bm25()` is negated so "lower is better", `ORDER BY rank` is the fast path, per-column weights, external-content tables with trigger sync, tokenizers `unicode61`/`porter`/`trigram` (3-char minimum), `snippet()`/`highlight()`; index size example: a 1,636 MiB corpus → 743 MiB `detail=full`, 340 MiB `detail=column`, 134 MiB `detail=none` | [FTS5] |

Implications for the FTS5 default: use an external-content FTS5 table over a `chunks` table so the text is stored once; chunk rows are ≤2 MB anyway (chunks are a few KB). Batch inserts are bounded by 100 parameters per statement (e.g. 25 rows × 4 columns), not by row size. `PRAGMA` is allowlisted and read-only, so no `PRAGMA page_size` tuning [workerd-pragma].

### 2.1 Brute-force cosine on Float32 BLOBs as the "no external service" fallback

Store each chunk's embedding as a `BLOB` of `Float32Array` bytes (1,024 dims = 4,096 bytes; 1,536 dims = 6,144 bytes — well under the 2 MB row limit) next to the FTS5 content, and score with a JS dot-product over pre-normalised vectors. Practical sizing, from the limits above plus a local measurement:

- Memory: 128 MB per isolate, shared with co-located DOs and the Thread/Knowledge state [W-limits][DO-mem]. Holding 10,000 × 1,024-d vectors in one `Float32Array` is 41 MB; 20,000 × 1,536-d is 123 MB — over budget. Reading in pages through the cursor avoids holding everything, at the cost of `rowsRead` billing ($0.001/M rows [RC]) and SQLite I/O per query.
- CPU: on this workstation (Node 24, Apple silicon, not workerd — **UNVERIFIED for workerd**) a scalar JS dot-product loop scores 10,000 × 1,024-d in 6.0 ms, 50,000 × 1,024-d in 29.8 ms, 100,000 × 768-d in 44.7 ms per query [local-bench]. Against the 30 s CPU limit the scan is never the bound; memory and I/O are.
- Practical ceiling: **≈10,000 chunks per Knowledge at 1,024 dims** in-memory (≈40 MB, ≈6 ms/query), or ≈50,000 streamed in pages of a few thousand rows (tens of ms CPU plus the reads). Beyond that, use Vectorize.
- Writes: embeddings written in the same `transactionSync` as the chunk text and the FTS5 row, so the fallback is fully consistent — the only vector option here with read-your-writes.

This is exactly the right shape for tests (no remote binding), for small Knowledge, and for the "Memory recall by similarity" future.

## 3. Vectorize

| Dimension | Finding | Source |
|---|---|---|
| Status | GA 2024-09-26 (V2 engine); V1 deprecated 2024-08-14 (`--deprecated-v1` in wrangler > 3.71.0; V1 limits: 100 indexes, 200k vectors, topK 20) | [VEC-changelog][VEC-limits] |
| Limits (Paid / Free) | 50,000 / 100 indexes per account; 20 M vectors per index; ≤1,536 dims float32; vector id ≤64 bytes; metadata 10 KiB per vector; **namespaces per index 50,000 / 1,000**, name ≤64 bytes; 10 metadata indexes per index, 64 bytes indexed per string; upsert batch 1,000 (Workers) / 5,000 (HTTP); topK 100 (50 with `returnValues` or `returnMetadata: "all"`); filter JSON ≤2,048 bytes. (The insert best-practices page still says "1,000 per index" for namespaces; the limits page and the 2024-10-24 changelog say 50,000 on Paid — the limits page is newer.) | [VEC-limits][VEC-filter][VEC-insert][VEC-changelog] |
| API | `insert`, `upsert` (replace, no merge), `query(vector, {topK, namespace, filter, returnValues, returnMetadata: "none"\|"indexed"\|"all"})`, `queryById`, `getByIds`, `deleteByIds`, `describe`; mutations return `mutationId`. REST adds `list` (paginated ids, ≤1,000 per page, `totalCount`, cursor with expiry) and index/metadata-index create/delete | [VEC-api][VEC-list][VEC-api-rest] |
| Consistency | Write-ahead log immediately, then asynchronous jobs bounded by 200,000 vectors or 1,000 updates, whichever first; batch to make data visible in "minutes" instead of "an hour" | [VEC-insert] |
| Scoring | Approximate by default; `returnValues: true` switches to exact scoring on original values at higher latency | [VEC-query] |
| Index config | `dimensions` and `metric` (cosine/euclidean/dot-product) immutable; kebab-case names; deleted names reusable; presets for bge-base (768), ada-002 (1536), Cohere multilingual v2 (768), Google multimodal (1408) | [VEC-create] |
| Metadata filters | `$eq $ne $in $nin $lt $lte $gt $gte`; metadata index must exist before vectors are inserted or those vectors are not filterable; namespace filter applies first, then metadata | [VEC-filter] |
| Pricing | Paid: 50 M queried + 10 M stored dims/month included, then $0.01/M queried, $0.05/100 M stored; Free: 30 M queried / 5 M stored; no charge per index, CPU or transfer | [VEC-pricing] |
| Local dev / tests | "There is no current local simulation for Vectorize"; `remote: true` proxies to a real index from `wrangler dev`, the Vite plugin and `@cloudflare/vitest-plugin` (`remoteBindings` defaults to `true` in its config schema); Miniflare's plugin is `vectorize:remote` only; writes hit real data and bill | [W-dev][VP-src][MF-vec] |
| Runtime creation | Index creation is REST/wrangler (`POST /accounts/{id}/vectorize/v2/indexes` with `name`, `config.dimensions`, `config.metric`); bindings are static config. A Worker could call REST with an API token, but it could not *bind* the new index without a redeploy; REST `query`/`upsert` work per index name | [VEC-api-rest] |

### 3.1 Per-Scope isolation options

| Option | Verdict | Why |
|---|---|---|
| **Namespace per Scope** (`namespace = scopeId`) | **Reference** | Filters before ANN; fits the 64-byte name because ScopeId ≤64 chars [ADR-1]; 50,000 per index is a per-Deployment ceiling on Scopes-with-vectors that matches the tens-of-thousands assumption; no provisioning on the hot path |
| Metadata filter per Scope | Rejected as the primary key | Filter runs after namespace; string metadata indexed only on the first 64 bytes, `$eq` on high-cardinality values is documented as fine but a cross-Scope bug is one missing filter away; use metadata for `knowledge` (second-level filter) and `doc` only [VEC-filter] |
| Index per Scope | Rejected | Needs a REST call plus a binding per Scope; contradicts "provisioning per Scope would make the Cloudflare API part of karmi's hot path" [ADR-1] |

Vector id: `{scope}/{knowledge}/{doc}#{chunk}` overflows 64 bytes (ScopeId alone may be 64) [VEC-limits][ADR-1]. Use the first 32 hex chars of SHA-256 over that string (128 bits) as the id and keep the mapping in the ledger.

Deleting a Scope's vectors: no namespace delete and `list` is index-wide [VEC-api-rest][VEC-list]. Each Knowledge DO keeps a `chunks(id, doc, seq, text, embedded_at)` table; `scope.destroy()` walks its Knowledge DOs and issues `deleteByIds` in batches, then `deleteAll()` [ADR-1]. Batch size for `deleteByIds` is not documented (UNVERIFIED); use ≤1,000 like upsert. Because deletes are asynchronous, the tombstone rule in [ADR-1] covers reads that race the delete.

## 4. AI Search (formerly AutoRAG)

| Dimension | Finding | Source |
|---|---|---|
| Identity / status | AutoRAG open beta 2025-04-07; renamed AI Search 2025-09-25 (models from OpenAI/Anthropic via AI Gateway); still "open beta", "free within these limits", pricing "at least 30 days before any billing begins"; old `/autorag/rags/` endpoints and `env.AI.autorag()` binding are legacy, "continue to work", no sunset date | [AIS-release][AIS-limits][AIS-migrate][AIS-binding] |
| Sources | Built-in storage (upload via Items API), R2 bucket, website crawl; Markdown Conversion for PDFs, images, Office, HTML; 4 MB per file | [AIS-sources] |
| Pipeline | Convert → chunk (size in tokens, model-dependent range; overlap 0–30 %) → embed with Workers AI or AI Gateway provider → store vectors and, if enabled, BM25 index in Vectorize; query: optional rewrite → embed → vector and/or keyword → RRF or max fusion → optional cross-encoder rerank → optional generation | [AIS-how][AIS-chunk][AIS-hybrid] |
| Embedding models | `@cf/baai/bge-m3` (1,024), `@cf/baai/bge-large-en-v1.5` (1,024), `@cf/qwen/qwen3-embedding-0.6b` (1,024), `@cf/google/embeddinggemma-300m` (768), `openai/text-embedding-3-small` and `-large` (1,536), `google-ai-studio/gemini-embedding-001` (1,536); **embedding model only settable at creation**; reranker `@cf/baai/bge-reranker-base` | [AIS-models][AIS-models-cfg] |
| Runtime management | `ai_search_namespaces` binding: `create({id, type?: "r2"\|"web-crawler", source?, embedding_model, ai_search_model, index_method: {vector, keyword}, chunk_size, chunk_overlap, sync_interval: 3600–86400})`, `update`, `get` (lazy, no network), `list` (≤100 per page), `delete` ("permanently removes an instance and indexed content"), `info`, `stats`; `instance.items.upload/uploadAndPoll/delete/list`; sync jobs via REST/wrangler, ≥30 s apart; default sync every 6 h, minimum 1 h | [AIS-binding-inst][AIS-cl-ns][AIS-sync] |
| Search without generation | `search({ query \| messages, ai_search_options: { retrieval: { retrieval_type, match_threshold (default 0.4), max_num_results 1–50 (default 10), filters (`$eq $ne $gt $gte $lt $lte`, `and`/`or`), context_expansion 0–3, keyword_match_mode }, query_rewrite, reranking } })` → `chunks[] {id, score, text, item, scoring_details}`; namespace-level `search` across `instance_ids` (≤10 per request) | [AIS-binding][AIS-limits] |
| Multi-tenancy | Cloudflare's own guidance: "Instance per tenant (recommended)" for "strong isolation or runtime tenant creation/deletion"; or one shared instance with folder-prefix filters `folder: {$gte: "${tenantId}/", $lt: "${tenantId}0"}` for "many small tenants" | [AIS-multi][AIS-tenant] |
| Limits | **Instances per account 100 (Free) / 5,000 (Paid)**; namespaces (a "logical grouping of instances within your account", one `default` per account, one binding per namespace) 100 per account; files per instance 100k / 1 M (500k with hybrid); queries 20k/month Free, unlimited Paid; 5 custom metadata fields; 10 KiB metadata per vector; 4 MB per file | [AIS-limits][AIS-ns][AIS-hybrid] |
| Local dev | "AI Search does not run locally"; `remote: true` required; Miniflare's `ai-search` plugin is remote-proxy only | [AIS-start][MF-ais] |
| Fit for a Framework | Instance-per-(Scope, Knowledge) hits 5,000 at 5,000 Knowledge across all Scopes; shared-instance-per-Deployment with folder filters works but caps each Deployment at 1 M files and 10 KiB metadata, forces Cloudflare's chunker, fixes one embedding model per instance and gives the Framework no ledger of its own. Pricing unknown. Not the reference; a clean optional adapter once the seam exists (its `search()` maps 1:1 onto `Retriever.search`) | [AIS-limits][AIS-models-cfg] |

## 5. Embeddings

Workers AI text-embedding models (all Cloudflare-hosted; batch and pricing from the docs' model JSON) [WAI-models][WAI-json][WAI-pricing]:

| Model | Dims | Max input | Batch (`text[]`) | $/M input tokens (neurons/M) | Notes |
|---|---|---|---|---|---|
| `@cf/baai/bge-m3` | 1,024 [AIS-models] | model JSON `context_window` 60,000; AI Search table says 512 (UNVERIFIED which applies per text) | 100 | $0.012 (1,075) | multilingual; also `query`/`contexts` mode; OpenAI-compatible `/v1/embeddings` route exists for Workers AI [WAI-compat] |
| `@cf/baai/bge-base-en-v1.5` | 768 | 512 tokens | 100 | $0.067 (6,058) | English; `pooling: mean\|cls`; Vectorize tutorial default [VEC-tutorial] |
| `@cf/baai/bge-large-en-v1.5` | 1,024 | 512 tokens | 100 | $0.204 (18,582) | English; 1,500 req/min instead of 3,000 [WAI-limits] |
| `@cf/baai/bge-small-en-v1.5` | 384 | — | — | $0.020 (1,841) | |
| `@cf/google/embeddinggemma-300m` | 768 [AIS-models] | 512 (AI Search table) | 100 | not on pricing page (UNVERIFIED) | "100+ spoken languages" |
| `@cf/qwen/qwen3-embedding-0.6b` | 1,024 [AIS-models] | 8,192 | 32 | $0.012 (1,075) | `instruction` parameter; OpenAI-compatible |
| `@cf/pfnet/plamo-embedding-1b` | — | — | — | $0.019 (1,689) | Japanese |

Workers AI: $0.011 per 1,000 neurons, 10,000 neurons/day free; text-embedding rate limit 3,000 requests/min [WAI-pricing][WAI-limits]. Workers AI has no local simulation either [W-dev].

Provider-side, through the provider seam [PS] (AI SDK `embed`/`embedMany` with `maxParallelCalls`, or a direct fetch adapter) [AI-emb]:

| Provider | Model | Dims | Max input | $/M tokens | Source |
|---|---|---|---|---|---|
| OpenAI | `text-embedding-3-small` / `-large` | 1,536 / 3,072, shortenable via `dimensions` | 8,192 | $0.02 / $0.13 | [OA-emb][OA-pricing] |
| Voyage (Anthropic's documented recommendation: "Anthropic does not offer its own embedding model") | `voyage-4-large` / `voyage-4` / `voyage-4-lite` (`voyage-context-4` for contextualised chunks, `rerank-2.5`) | 1,024 default; 256/512/2,048 | 32,000 | $0.12 / $0.06 / $0.02; first 200 M tokens free; `input_type: query\|document` | [AN-emb][VO-pricing] |
| Google | `gemini-embedding-2` (`-001` legacy) | 128–3,072 (768/1,536/3,072 recommended) | 8,192 | $0.20 ($0.15 for -001) | [GG-emb][GG-pricing] |

AI Gateway: the provider list has no Voyage; the OpenAI provider page documents only chat/completions and responses; the 2025-06-03 `/compat` changelog said "embeddings endpoint coming up next" and nothing later in the AI Gateway changelog confirms it; the unified REST API lists `/ai/run`, `/ai/v1/chat/completions`, `/ai/v1/responses`, `/ai/v1/messages` only [AIG-providers][AIG-openai][AIG-cl][AIG-rest]. Proxying embeddings through AI Gateway is therefore **UNVERIFIED**; the reference must not depend on it (call providers directly, or Workers AI via binding).

**Default and ownership.** `@cf/baai/bge-m3` is the reference default: multilingual, 1,024 dims (leaves room under Vectorize's 1,536), cheapest per token, batch 100, and the same id AI Search offers, so a later AI Search adapter shares vectors' semantics [WAI-pricing][AIS-models]. The embedding model + dimensions + metric are a **Knowledge-level fact** (`Knowledge.index = { model, dims, metric, adapter }`) fixed at first ingest, because the Vectorize index config is immutable and re-embedding is a full reindex [VEC-create]; ScopeConfig holds only `retriever.defaults` for new Knowledge, merged from Deployment defaults [ADR-1]. Changing the model is explicit: `knowledge.reindex({ model })` runs as a Job and swaps the pointer when done.

Ingest/reindex cost, for scale: 100,000 chunks × 400 tokens = 40 M tokens → $0.48 on bge-m3, $0.80 on OpenAI small, $0.80–2.40 on Voyage, $8.00 on Gemini 2 [WAI-pricing][OA-pricing][VO-pricing][GG-pricing]; 100,000 × 1,024 dims = 102 M stored dimensions → ≈$0.05/month above the included 10 M on Vectorize; 1,000 queries/day × 1,024 = 31 M queried dims/month, inside the 50 M included [VEC-pricing]. Wall time is bounded by 3,000 embedding requests/min × 100 texts, i.e. one Job can embed 100k chunks in ≈1–2 min of requests spread over subrequests [WAI-limits].

## 6. Bring-your-own stores (REST from a Worker)

| Store | Tenant model | Why not reference |
|---|---|---|
| Turbopuffer | Namespace per tenant, "Unlimited (seen: 250M+)" namespaces per org, up to 10,752 dims; $16/month minimum, no free tier | Paid minimum, external account and residency; ideal BYO for large fleets [TP-limits][TP-pricing] |
| Pinecone | "one namespace per customer"; 100,000 namespaces standard; `delete_namespace` in one operation | External account; the one with first-class namespace delete [PC-ns][PC-del] |
| Qdrant Cloud | Payload partition with `is_tenant=true`; collection-per-tenant "rarely the most efficient", 1,000 collections per cluster; per-tenant `idf` for BM25 | Cluster to run; filter-based isolation only [QD-multi] |
| Upstash Vector | Namespaces created implicitly on upsert, delete-namespace API, path-based REST | Simple REST fit; no primary-source limits found (UNVERIFIED) [UP-ns] |
| pgvector via Hyperdrive | Postgres/MySQL pooling from Workers, Free and Paid plans, `localConnectionString` for dev; no pgvector mention in Cloudflare docs | User runs Postgres; a fine BYO adapter, not a default [HD] |

All are "adapter implements `VectorStore`" cases: none is needed in v0 beyond the interface and one conformance test suite.

## 7. Comparison matrix

| | **Vectorize** | **AI Search** | **BYO (Turbopuffer/Pinecone/…)** | **DO-SQLite brute force** |
|---|---|---|---|---|
| Per-Scope isolation | Namespace = ScopeId, filtered before ANN [VEC-insert] | Instance per (Scope, Knowledge) or folder-prefix filter [AIS-multi] | Namespace/filter per store | Inherent: the Knowledge DO is named `{scope}/knowledge/{name}` [ADR-1] |
| Runtime-created Scopes | Yes, no provisioning; ≤50,000 namespaces/index Paid [VEC-limits] | Yes via `create()`, but ≤5,000 instances/account [AIS-limits] | Yes | Yes |
| Deletion on `scope.destroy()` | `deleteByIds` from the ledger; no namespace delete [VEC-api-rest] | `delete(instance)` removes everything [AIS-tenant] | Pinecone/Upstash: one call; others: filter delete | `deleteAll()` on the DO [ADR-1] |
| Embedding choice | Any ≤1,536 dims; the Framework calls the model [VEC-limits] | Fixed per instance from a Cloudflare list [AIS-models-cfg] | Any | Any (BLOB) |
| Ingest / reindex cost | Embedding tokens + stored dims; async visibility, minutes when batched [VEC-insert][VEC-pricing] | Free in beta; Cloudflare chunks and embeds; sync ≥1 h or manual ≥30 s apart [AIS-limits][AIS-sync] | Embedding tokens + vendor | Embedding tokens + DO rows written ($1/M) [RC] |
| Local testing | Remote binding only; real index, real bill [W-dev] | Remote only [AIS-start] | Network | Fully local in workerd/Miniflare [MF-readme] |
| Consistency | Eventual (mutation jobs) [VEC-insert] | Eventual (async upload, sync jobs) [AIS-tenant] | Vendor-specific | Read-your-writes, same transaction |
| Limits | 20 M vectors/index, 1,536 dims, topK 100/50, 10 KiB metadata [VEC-limits] | 1 M files/instance (500k hybrid), 4 MB/file, 5 metadata fields [AIS-limits] | Very high | ≈10k chunks in-memory, ≈50k streamed (§2.1, UNVERIFIED for workerd) |
| Pricing | $0.01/M queried dims, $0.05/100 M stored; free tier [VEC-pricing] | Unknown post-beta [AIS-limits] | $16+/month or usage | DO storage $0.20/GB-month, rows read/written [RC] |
| Lock-in | Cloudflare API shape; vectors exportable by `list`+`getByIds` [VEC-list] | Whole pipeline (chunker, index) is Cloudflare's | Vendor | None |

## 8. Recommendation in detail

### 8.1 The seam

The Retriever stays a Catalogue item referenced by name from an Agent Spec [P7]. Two layers: a `Retriever` (what Knowledge search and Memory recall call) and, inside the vector Retriever, a `VectorStore` (what Vectorize / brute-force / BYO implement). Scope is threaded exactly as everywhere else in karmi — as an explicit argument, never ambient [ADR-2].

```ts
import { z } from "zod";

export type ScopeId = string;                       // opaque, [A-Za-z0-9_-]{1,64} [ADR-1]
export interface KnowledgeRef { scope: ScopeId; name: string }

export interface Doc   { id: string; text: string; metadata?: Record<string, string | number | boolean> }
export interface Chunk { id: string; doc: string; seq: number; text: string; metadata?: Doc["metadata"] }
export interface Hit   { chunk: Chunk; score: number; source: "fts" | "vector" | "hybrid" }

export interface SearchOptions {
  topK?: number;                                    // default 10; vector adapters cap at store limits (Vectorize 100/50)
  filter?: { doc?: string[]; metadata?: Record<string, string | number | boolean> };
  mode?: "fts" | "vector" | "hybrid";               // default = retriever.defaultMode
}

export interface Retriever {
  readonly name: string;
  index(ref: KnowledgeRef, docs: Doc[], ctx: RetrieverCtx): Promise<{ chunks: number; pending?: string }>;
  search(ref: KnowledgeRef, query: string, opts: SearchOptions, ctx: RetrieverCtx): Promise<Hit[]>;
  delete(ref: KnowledgeRef, docIds: string[], ctx: RetrieverCtx): Promise<void>;
  destroy(ref: KnowledgeRef, ctx: RetrieverCtx): Promise<void>;   // called by scope.destroy() per Knowledge
}

export interface RetrieverCtx {                     // explicit, not AsyncLocalStorage [ADR-2]
  storage: SqlStorage;                              // the Knowledge DO's SQLite (chunks + FTS5 + ledger)
  embed?: Embedder;                                 // resolved from Knowledge.index.model via the provider seam or Workers AI
  vectors?: VectorStore;                            // resolved from Knowledge.index.adapter
  job?: JobHandle;                                  // present when index() runs inside a Job
}

export interface Embedder {
  readonly model: string; readonly dims: number; readonly metric: "cosine" | "dot-product" | "euclidean";
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;   // adapter batches (bge-m3: 100)
}

export interface VectorStore {                      // implemented by VectorizeStore, SqliteBruteForceStore, BYO
  upsert(ns: ScopeId, rows: { id: string; values: Float32Array; metadata: { knowledge: string; doc: string } }[]): Promise<void>;
  query(ns: ScopeId, vector: Float32Array, opts: { topK: number; knowledge: string; doc?: string[] }): Promise<{ id: string; score: number }[]>;
  deleteByIds(ns: ScopeId, ids: string[]): Promise<void>;
}

export const knowledgeIndexSchema = z.object({     // Knowledge-level fact, fixed at first ingest
  model: z.string(),                                // "@cf/baai/bge-m3"
  dims: z.number().int().max(1536),
  metric: z.enum(["cosine", "dot-product", "euclidean"]),
  adapter: z.string(),                              // "vectorize" | "sqlite" | a BYO Catalogue name
  chunking: z.object({ maxTokens: z.number().int(), overlap: z.number().min(0).max(0.3) }),
});
```

Placement decisions:

- **Chunking is the Framework's**, run in `index()` inside the Knowledge DO (or its Job for bulk): deterministic, recorded per Knowledge, testable locally; AI Search's chunker is exactly what we do not want to depend on for the reference [AIS-chunk].
- **The embedding call lives in the Retriever**, via `Embedder`, never in the VectorStore, so a store swap never re-embeds and a model swap is a visible reindex.
- **The ledger** (`chunks`, `docs`, FTS5 `chunks_fts` external-content table, `vector_ids`) lives in the Knowledge DO's SQLite. Every vector adapter is a mirror of the ledger; `destroy()` is "ledger → `deleteByIds` in ≤1,000-id batches → `deleteAll()`" [VEC-api][ADR-1].
- **Scope threading**: `ref.scope` is the Vectorize namespace and the prefix of the Knowledge DO name; only the internal `keys` module builds either [ADR-1]. `VectorStore` methods take `ns` explicitly so a forgotten Scope is a type error, not a leak.
- **Bulk ingest is a Job**: `index()` returns `{ pending: jobId }` above a threshold (e.g. > 100 docs or > 1 MB), chunks and embeds in batches of 100 texts, upserts in batches of 1,000, and checkpoints progress in the ledger so a re-run is idempotent [CTX-Job][VEC-limits][WAI-json].
- **Hybrid**: `search(mode: "hybrid")` runs the FTS5 query (`ORDER BY rank`, topK × 3) and the vector query in parallel, fuses by reciprocal rank (RRF, as AI Search's default fusion does [AIS-hybrid]), and returns `source: "hybrid"`. The rank constant (60 in the usual formulation) is a Retriever option; no fetched primary source fixes the value — UNVERIFIED as a "standard".
- **Memory recall** stays on the FTS5 Retriever in v0: the same-Turn `remember` → `recall` expectation needs read-your-writes, which Vectorize's asynchronous mutations do not give [VEC-insert].

### 8.2 The two shipped VectorStore adapters

1. `SqliteBruteForceStore` — Float32 BLOBs in the ledger, in-memory scan up to a configured `maxChunks` (default 10,000), paged scan above it, cosine on pre-normalised vectors. Default `adapter` when none is set; the only one the test suite needs.
2. `VectorizeStore` — one binding per embedding model (`KNOWLEDGE_VECTORS_BGE_M3`, index `karmi-bge-m3-1024-cosine`), namespace = ScopeId, id = `sha256(scope/knowledge/doc#seq)[0:32]`, metadata `{ knowledge, doc }` with metadata indexes on both created at index creation (before any vector) [VEC-filter], `returnMetadata: "indexed"`, `topK ≤ 100`. `karmi doctor` [ADR-2] checks the bound index's `describe()` dims/metric against the Knowledge's `index` record. Adapter tests run under `remote: true` against a `karmi-test-*` index and are skipped without credentials.

### 8.3 Out of v0

AI Search adapter (interface-compatible, design sketched in §4); BYO adapters; rerankers (`bge-reranker-base` or Voyage `rerank-2.5`); multimodal embeddings; Memory recall by similarity; per-Scope embedding quotas as a Capability; Vectorize index per Scope or per jurisdiction.

### 8.4 Open questions

1. Do Scope counts in a Deployment exceed 50,000 namespaces per index [VEC-limits]? If yes, shard Scopes across N indexes by hash at Deployment level — still static bindings.
2. `deleteByIds` batch limit and whether `list` can filter by namespace — neither documented [VEC-api-rest][VEC-list]; ask Cloudflare or test.
3. bge-m3's real per-text token limit on Workers AI (60,000 "context window" vs 512 in AI Search's table) [WAI-json][AIS-models]; measure before fixing `chunking.maxTokens` defaults.
4. Whether AI Gateway ever shipped an embeddings route [AIG-cl]; if it does, Voyage/OpenAI embeddings could share the Scope's gateway metadata and spend limits [PS].
5. Whether `@cloudflare/vitest-plugin` is the successor of `vitest-pool-workers` [VP-npm][VP-src]; [ADR-2] names the latter.
6. Brute-force timings inside workerd (V8 without JIT differences, DO memory pressure) — reproduce §2.1's numbers in a `vitest-plugin` benchmark before publishing `maxChunks` defaults [local-bench].

## 9. Sources

[ADR-1]: ../adr/0001-scope-name-based-isolation.md
[ADR-2]: ../adr/0002-compatibility-baseline.md
[RC]: ./runtime-comparison.md
[PS]: ./provider-seam.md
[P7]: https://github.com/dsblabs/karmi/issues/7 (resolution comment, 2026-08-29)
[P14]: https://github.com/dsblabs/karmi/issues/14 (resolution comment, 2026-08-29)
[CTX-Job]: ../../CONTEXT.md (Job, Knowledge, Retriever, Memory entries)
[workerd-build]: https://github.com/cloudflare/workerd/blob/main/build/BUILD.sqlite3 (`SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_RTREE`, `SQLITE_ENABLE_MATH_FUNCTIONS`, `SQLITE_MAX_ALLOCATION_SIZE`)
[workerd-module]: https://github.com/cloudflare/workerd/blob/main/MODULE.bazel (`sqlite-src-3530400`)
[workerd-vtab]: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++ (`SQLITE_CREATE_VTABLE` case, ~line 1298)
[workerd-funcs]: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++ (`ALLOWED_SQLITE_FUNCTIONS`, ~lines 360–475)
[workerd-pragma]: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++ (`ALLOWED_PRAGMAS`, ~line 543)
[workerd-sql-h]: https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.h (`SqlStorageValue`, `BindingValue`)
[sqlite-vec]: https://github.com/asg017/sqlite-vec
[DO-sql]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
[DO-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/ (last updated 2026-06-01)
[DO-mem]: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/ and https://developers.cloudflare.com/changelog/post/2026-06-30-memory-usage-metrics/
[W-limits]: https://developers.cloudflare.com/workers/platform/limits/
[W-dev]: https://developers.cloudflare.com/workers/development-testing/
[VP-npm]: https://www.npmjs.com/package/@cloudflare/vitest-plugin (1.1.2, 2026-08-28) and https://www.npmjs.com/package/@cloudflare/vitest-pool-workers (0.22.0, 2026-08-18)
[VP-src]: https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/src/pool/config.ts (`remoteBindings: z.boolean().default(true)`)
[MF-readme]: https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md
[MF-vec]: https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/vectorize/index.ts
[MF-ais]: https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/ai-search/index.ts
[FTS5]: https://www.sqlite.org/fts5.html
[local-bench]: Node 24.19.0 on the author's Apple-silicon workstation, scalar `Float32Array` dot-product loop, mean of 5 runs after warm-up; not workerd
[VEC-limits]: https://developers.cloudflare.com/vectorize/platform/limits/ (last updated 2026-08-05)
[VEC-pricing]: https://developers.cloudflare.com/vectorize/platform/pricing/
[VEC-insert]: https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
[VEC-query]: https://developers.cloudflare.com/vectorize/best-practices/query-vectors/
[VEC-create]: https://developers.cloudflare.com/vectorize/best-practices/create-indexes/
[VEC-api]: https://developers.cloudflare.com/vectorize/reference/client-api/
[VEC-filter]: https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
[VEC-api-rest]: https://developers.cloudflare.com/api/resources/vectorize/
[VEC-list]: https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/list_vectors/
[VEC-changelog]: https://developers.cloudflare.com/vectorize/platform/changelog/
[VEC-tutorial]: https://developers.cloudflare.com/vectorize/get-started/embeddings/
[AIS-release]: https://developers.cloudflare.com/ai-search/platform/release-note/
[AIS-limits]: https://developers.cloudflare.com/ai-search/platform/limits-pricing/ (last updated 2026-08-26)
[AIS-sources]: https://developers.cloudflare.com/ai-search/configuration/data-source/
[AIS-how]: https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/
[AIS-chunk]: https://developers.cloudflare.com/ai-search/configuration/chunking/
[AIS-models]: https://developers.cloudflare.com/ai-search/configuration/models/supported-models/
[AIS-models-cfg]: https://developers.cloudflare.com/ai-search/configuration/models/
[AIS-hybrid]: https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/
[AIS-sync]: https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/
[AIS-binding]: https://developers.cloudflare.com/ai-search/api/search/workers-binding/
[AIS-binding-inst]: https://developers.cloudflare.com/ai-search/api/instances/workers-binding/
[AIS-start]: https://developers.cloudflare.com/ai-search/get-started/workers/
[AIS-multi]: https://developers.cloudflare.com/ai-search/how-to/multitenancy/
[AIS-tenant]: https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/
[AIS-ns]: https://developers.cloudflare.com/ai-search/concepts/namespaces/
[AIS-migrate]: https://developers.cloudflare.com/ai-search/how-to/migrate-from-autorag-api/
[AIS-cl-ns]: https://developers.cloudflare.com/changelog/post/2026-04-16-ai-search-namespace-binding/
[AIS-cl-hybrid]: https://developers.cloudflare.com/changelog/post/2026-04-16-hybrid-search-and-relevance-boosting/
[AIS-blog]: https://blog.cloudflare.com/ai-search-agent-primitive/ (2026-04-16)
[WAI-models]: https://developers.cloudflare.com/workers-ai/models/ (Text Embeddings)
[WAI-json]: https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/workers-ai-models (`bge-m3.json`, `bge-base-en-v1.5.json`, `bge-large-en-v1.5.json`, `embeddinggemma-300m.json`, `qwen3-embedding-0.6b.json`; `maxItems`, `max_input_tokens`, `output_dimensions`, `price`)
[WAI-pricing]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[WAI-limits]: https://developers.cloudflare.com/workers-ai/platform/limits/
[WAI-compat]: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
[AIG-providers]: https://developers.cloudflare.com/ai-gateway/usage/providers/
[AIG-openai]: https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
[AIG-rest]: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
[AIG-cl]: https://developers.cloudflare.com/changelog/product/ai-gateway/ and https://developers.cloudflare.com/changelog/post/2025-06-03-aig-openai-compatible-endpoint/
[AI-emb]: https://ai-sdk.dev/docs/ai-sdk-core/embeddings
[OA-emb]: https://developers.openai.com/api/docs/guides/embeddings
[OA-pricing]: https://developers.openai.com/api/docs/pricing
[AN-emb]: https://platform.claude.com/docs/en/build-with-claude/embeddings
[VO-pricing]: https://docs.voyageai.com/docs/pricing
[GG-emb]: https://ai.google.dev/gemini-api/docs/embeddings
[GG-pricing]: https://ai.google.dev/gemini-api/docs/pricing
[TP-limits]: https://turbopuffer.com/docs/limits
[TP-pricing]: https://turbopuffer.com/pricing
[PC-ns]: https://docs.pinecone.io/guides/index-data/indexing-overview
[PC-del]: https://docs.pinecone.io/guides/manage-data/manage-namespaces
[QD-multi]: https://qdrant.tech/documentation/guides/multiple-partitions/
[UP-ns]: https://upstash.com/docs/vector/features/namespaces
[HD]: https://developers.cloudflare.com/hyperdrive/
