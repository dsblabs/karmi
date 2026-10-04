---
"@karmi/core": patch
---

A Compaction that runs between a tool Step and the next model Step no longer sends the results of that tool Step twice. Before this fix, Anthropic models rejected the request with "each tool_use must have a single result", and each later Turn on the Thread failed. A Thread that has this error works again after the update, because the transcript is built from the event log on each Step.
