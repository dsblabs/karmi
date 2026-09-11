---
"@karmi/core": patch
"@karmi/anthropic": patch
---

Compaction: a `compact` Step before a fresh model Step when the context is over `window - reserveTokens`, after a `context_window_exceeded` stop, or on `thread.compact({ instructions })`; the cut keeps `keepRecentTokens` at a Turn (or tool Step) boundary, the Harness or the provider (`ProviderConfig.compaction: "provider"`) writes the summary, and `thread.compacted` is appended without rewriting the log. `before-compact` may skip or supply the summary, `after-compact` observes. `context.window` defaults to the adapter's `capabilities(model).contextWindow` under the Scope ceiling `ceilings.context.window`. `thread.fork(seq)` copies the log up to a seq into a new Thread. `@karmi/anthropic` maps `ProviderRequest.compact` to a forced `compact_20260112` edit and reports a 200k context window.
