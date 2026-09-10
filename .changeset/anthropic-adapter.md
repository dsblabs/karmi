---
"@karmi/anthropic": patch
"@karmi/core": patch
---

`@karmi/anthropic`: the Anthropic Provider on `@anthropic-ai/sdk` — streaming into `ProviderEvent`s (text, adaptive thinking with signatures, tool calls, server tools and `tool_reference` results byte-exact, compaction, fallback hops), `stop_details`, cumulative usage with the 1h cache split, `countTokens`, a capabilities table, tagged errors with retryable classification, and Cloudflare AI Gateway as pure profile configuration (`cf-aig-authorization`, BYOK, `cf-aig-metadata`, `cf-aig-log-id` onto `Usage.gateway`).

`@karmi/core`: `scopedFetch` (vendored SSRF guard, manual redirects, hostname allow-list, synthetic 403) built per Turn and handed to every Provider call along with `attribution` and a `Logger`; the shared `retry` helper; `fakeProvider` scripts receive the call `options`.
