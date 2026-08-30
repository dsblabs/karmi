# Anthropic-only AI SDK stream blocks and Cloudflare beta passthrough

Spike note, 2026-08-30, for the ticket “Spike: AI SDK stream shape for
Anthropic-only blocks and anthropic-beta passthrough on AI Gateway”. Primary
sources only: the published `@ai-sdk/anthropic` 4.0.45 package and its upstream
tests, Anthropic documentation, Cloudflare documentation, and the live
Cloudflare account.

## Result

The AI SDK half is settled for `@ai-sdk/anthropic` 4.0.45:

| Anthropic block | `doStream()` representation | With `includeRawChunks: true` |
| --- | --- | --- |
| `compaction` | `text-start` with `providerMetadata.anthropic.type = "compaction"`, then `text-delta` for each `compaction_delta`, then `text-end` | The original `content_block_start`, deltas, and stop events are also emitted as `raw` parts. |
| `fallback` | No content part. It is deliberately dropped because LanguageModelV4 has no model-hop primitive. The hop remains in `finish.providerMetadata.anthropic.iterations` as a `fallback_message`, including the served model and usage. | The original fallback marker is also emitted as a `raw` part. |
| `mcp_tool_use` | A typed dynamic `tool-call` with `providerExecuted: true`; Anthropic metadata carries `type: "mcp-tool-use"` and `serverName`. The paired `mcp_tool_result` becomes a typed dynamic `tool-result`. | The original MCP events are also emitted as `raw` parts. |

This is not inferred from generic stream documentation. Version 4.0.45's
parser explicitly implements all three cases, and its upstream fixtures test
fallback, MCP and raw-chunk output. At the LanguageModelV4 layer,
`includeRawChunks` emits every provider event as a `raw` part *before* schema
validation and before any mapped typed part. A schema-invalid future event is
therefore emitted as `raw` followed by an SDK `error`; raw capture does not make
an unknown event acceptable to the normalized stream. At the high-level
`streamText` API the current spelling is `include: { rawChunks: true }`.
[Parser source][ai-parser]
[Fallback stream test][ai-tests] [MCP snapshot][ai-snapshot]

Implication for karmi: the AI SDK breadth adapter can carry all three blocks,
but replay fidelity still requires preserving Anthropic metadata/raw events.
Compaction should map to karmi's first-class compaction block rather than
ordinary text. MCP calls map cleanly to provider-executed tool events. Fallback
must be reconstructed from `iterations` (and optionally the raw marker), not
from typed content.

The Cloudflare half is also settled. A live request through the native
`/anthropic/v1/messages` route carried
`anthropic-beta: server-side-fallback-2026-07-01` and
`fallbacks: "default"`. Anthropic returned HTTP 200 from `claude-fable-5`, with
7 input tokens and 1 output token. Because `fallbacks` is beta-gated and would
be rejected without its beta, the successful provider response proves that AI
Gateway forwarded `anthropic-beta`. [Anthropic route][cf-anthropic]
[BYOK][cf-byok]

## Live test

The development gateway is authenticated and uses stored Anthropic BYOK. The
conclusive request used a temporary account token carrying only
`AI Gateway Run`, a one-character prompt and `max_tokens: 1`:

- route: native `/anthropic/v1/messages`
- beta: `server-side-fallback-2026-07-01`
- beta-gated body field: `fallbacks: "default"`
- response: HTTP 200, `type: "message"`, model `claude-fable-5`
- usage: 7 input tokens, 1 output token

An earlier attempt to use `/v1/messages/count_tokens` was rejected because that
endpoint does not permit `fallbacks`; it cannot validate this beta without a
generation. The successful one-token generation was therefore the minimum
conclusive test.

## Sources

- [Published `@ai-sdk/anthropic` 4.0.45 package][ai-npm] (the exact package
  inspected; source is included in the tarball)
- [AI SDK Anthropic parser source][ai-parser]
- [AI SDK Anthropic fallback and raw-chunk tests][ai-tests]
- [AI SDK MCP output snapshot][ai-snapshot]
- [Cloudflare native Anthropic route][cf-anthropic]
- [Cloudflare BYOK configuration][cf-byok]

[ai-npm]: https://www.npmjs.com/package/@ai-sdk/anthropic/v/4.0.45
[ai-parser]: https://github.com/vercel/ai/blob/5366b7baeb41f12dbaba17efe388b401008eb437/packages/anthropic/src/anthropic-language-model.ts
[ai-tests]: https://github.com/vercel/ai/blob/5366b7baeb41f12dbaba17efe388b401008eb437/packages/anthropic/src/anthropic-language-model.test.ts
[ai-snapshot]: https://github.com/vercel/ai/blob/5366b7baeb41f12dbaba17efe388b401008eb437/packages/anthropic/src/__snapshots__/anthropic-language-model.test.ts.snap
[cf-anthropic]: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
[cf-byok]: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
