# @karmi/anthropic

The Anthropic Provider for karmi: the full Messages API surface on `@anthropic-ai/sdk`, reached directly or through Cloudflare AI Gateway by profile configuration alone.

```ts
import { createKarmi } from "@karmi/core";
import { anthropic } from "@karmi/anthropic";

export const karmi = createKarmi({
  catalogue,
  providers: { anthropic: anthropic({ apiKey: env.ANTHROPIC_API_KEY }) },
  defaults: { providers: { default: { adapter: "anthropic" } } },
});
```

A Provider profile decides how the adapter reaches Anthropic:

- **Direct**: `credential: "scope:<name>"` or `"deployment:<name>"`, which karmi resolves through its `SecretsProvider` right before each call and hands over as `credentials.provider`; or the adapter's `apiKey` for profiles that name no credential.
- **AI Gateway**: `gateway: { kind: "cloudflare", accountId, gatewayId, credential, byok: true }` sends `cf-aig-authorization`, stamps `cf-aig-metadata { scope, agent, thread, turn }` plus one Platform entry, and records `cf-aig-log-id` on the call's Usage. With `byok` no provider auth header leaves the Worker.

What streams back is karmi's own vocabulary: text, adaptive thinking with signatures, tool calls, server-tool calls joined with their byte-exact results, compaction and fallback blocks, `stop_details`, and cumulative usage including the 1h cache split. `providerOptions.anthropic` forwards `thinking`, `effort`, `fallbacks`, `contextManagement`, `taskBudget`, `mcpServers`, `cache` and `betas`; the betas each feature needs are added for you. A Harness `compact` request becomes a forced `compact_20260112` edit that pauses with the block, so a Provider profile with `compaction: "provider"` delegates Compaction to the API.

Every request goes through the `fetch` karmi injects, so a Scope's egress policy applies before the SDK sees a byte.

Media refs are read through the call's `media` access and encoded as base64 image/PDF blocks, including in Tool results and token-count requests. Definite capability denials, oversized refs and missing R2 objects become text placeholders. Native MCP image content is stored before being emitted, then restored when replayed to Anthropic.

Provider Tool version pins live in `ProviderConfig.providerOptions.anthropic.serverTools`. A pin never grants a tool: the Spec must grant its abstract name through `capabilities.providerTools`. The request carries only Policy-allowed tools with budget remaining.
