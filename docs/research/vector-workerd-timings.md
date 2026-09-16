# SQLite vector scan timings

Measured on 2026-09-16 with workerd 1.20260903.1 on Linux arm64, through
`@cloudflare/vitest-plugin` 1.1.4. Reproduce with:

```sh
pnpm --filter @karmi/core test:vector-bench --reporter=verbose
```

Each corpus contains 1,024-dimensional Float32 vectors in a real SQLite Durable
Object. Each query scans the corpus for the top 10 cosine matches. Timings include
SQL reads, scoring, sorting the bounded result list, and the local Durable Object
test call. These are local elapsed times, not production CPU billing measurements.
The first of six runs is treated as warmup.

| Chunks | Page size | Six runs (ms) | Warm median (ms) |
| --- | --- | --- | --- |
| 1,000 | 1,000 | 5, 4, 4, 3, 3, 4 | 4 |
| 1,000 | 10,000 | 9, 3, 3, 3, 3, 3 | 3 |
| 10,000 | 1,000 | 24, 23, 26, 23, 21, 23 | 23 |
| 10,000 | 10,000 | 21, 26, 21, 26, 20, 21 | 21 |

`maxChunks` defaults to **1,000 rows per read**, or about 3.9 MiB of raw vector
data at 1,024 dimensions. The 10,000-row read uses about 39 MiB before row and
array overhead, for only a 2 ms median improvement on the 10,000-chunk corpus.
Larger corpora continue in pages; this option does not reject ingestion or limit
search to the first page. Applications can override it after measuring their
own dimensions, corpus sizes and concurrency. The result list retains at most
`topK` entries, independently of corpus size.
