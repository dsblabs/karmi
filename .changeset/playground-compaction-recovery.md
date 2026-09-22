---
"@karmi/core": minor
---

Added the Playground scenario "Compaction and recovery". The scenario shows these parts of a Thread:

- A compact Step before a model Step when the context is over the limit, with the summary and the first kept event.
- A Compaction on request, with instructions.
- The recovery of a Turn after a stop of the dev server, from a terminal walkthrough.
- An interrupted read-only Tool call that runs again, and an interrupted call without `idempotentHint` that gets an error result.
