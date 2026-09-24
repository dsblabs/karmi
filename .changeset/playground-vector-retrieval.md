---
"@karmi/core": minor
---

Added the optional Playground scenario "Vector retrieval and index rebuild". A shop guide Agent searches a corpus with a vector Retriever in hybrid mode. Workers AI embeds each chunk, and a Vectorize index keeps a copy of each vector. The scenario shows:

- Keyword, vector and hybrid Passages for the same query, and the difference to the default Retriever `fts5`.
- A guide with the same id in the second sample Scope, which a search of the first Scope never finds.
- A rebuild that writes the saved vectors to a cleared index again, with the same opaque ids and no embedding call.
- A reset that destroys the corpora and deletes their vectors from the index.

`pnpm deploy` asks whether to enable vector retrieval. A yes creates a Vectorize index and binds Workers AI. `--vector-index` supplies an existing index. `pnpm run remove` deletes an owned index and keeps a supplied one. Local development has no Workers AI or Vectorize, thus the scenario needs a deployment.
