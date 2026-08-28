# Provider seam: existing model-abstraction library vs own adapters

Research note, 2026-08-29, answering GitHub issue #4. Primary sources only: ai-sdk.dev docs and the `vercel/ai` repo (changelogs, `package.json`, provider spec source), developers.cloudflare.com (AI Gateway, Workers AI, Workers limits, `nodejs_compat`), openrouter.ai/docs, the `earendil-works/pi` repo (`packages/ai` README and source; `badlogic/pi-mono` redirects there), platform.claude.com, developers.openai.com/api/docs (platform.openai.com/docs now 301-redirects there), ai.google.dev, the npm registry and bundlephobia's `/api/size` endpoint, and the official SDK repos. Every claim cites a bracket key from section 6; anything not verifiable from a primary source is marked UNVERIFIED. Glossary terms (Framework, Harness, Primitive, Capability, Channel, Scope) follow `CONTEXT.md`; the three-level turn/message/delta stream is the one chosen in `docs/research/harness-baseline.md` [HB §2.3]; runtime constraints are from `docs/research/runtime-comparison.md` [RC].

Date-sensitive: the AI SDK went to v7 on 2026-06-25 (ESM-only, Node 22, `LanguageModelV4`) [AI-npm][AI-mig7]; `@mariozechner/pi-ai` was renamed to `@earendil-works/pi-ai` (old package deprecated on npm) [PI-npm-old][PI-pkg]; Cloudflare AI Gateway deprecated its Universal Endpoint and the single-model `/compat/chat/completions` in favour of the `api.cloudflare.com/.../ai/v1/*` REST API [AIG-universal][AIG-compat][AIG-rest]; Anthropic made `thinking: {type: "adaptive"}` the only thinking mode on Claude 4.7+ and shipped server-side fallbacks, compaction and mid-conversation system messages [AN-think][AN-ext][AN-fallback][AN-compact][AN-midsys].

## 1. Summary and recommendation

**Recommendation: the hybrid. karmi owns the seam; it does not adopt any library's message type, stream type or loop.**

Concretely:

1. **karmi owns** an internal `Message`/content-block schema, a `ProviderEvent` stream vocabulary that maps 1:1 onto the turn/message/delta levels already chosen [HB §2.3], a `Usage` type with cache fields, a `ProviderConfig` resolved per Scope, and a `Provider` interface whose only required method is `stream(request): AsyncIterable<ProviderEvent>` (section 4). These are the types persisted in DO SQLite, so they must be plain JSON and must not change when a dependency bumps a major.
2. **karmi depends on `@anthropic-ai/sdk` for a direct Anthropic adapter** (the reference adapter). It is MIT, ~50 KB gzipped, lists Cloudflare Workers as a supported runtime, keeps Node built-ins out of the root entry, and exposes every current Messages API feature the Harness needs (adaptive thinking with signature replay, `output_config.effort`, `fallbacks`, compaction blocks, `role:"system"` mid-conversation, `strict`, `eager_input_streaming`, `stop_details`, `pause_turn`, task budgets, server tools, MCP connector, `count_tokens`) on the day Anthropic ships it, via `client.beta.messages` and `betas: [...]` [AN-sdk-npm][AN-sdk][AN-sdk-scan].
3. **karmi depends on the Vercel AI SDK (`ai` + `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, optionally `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex/edge`, and Cloudflare's `workers-ai-provider`) for a second, breadth adapter** that wraps `LanguageModel.doStream()` — the single-call spec layer — and never `streamText`'s multi-step loop or `ToolLoopAgent`. `ai` 7.x is Apache-2.0, ~95 KB gzipped, has no Node built-ins on its main path, and its provider spec already carries everything the internal schema needs (tool-input deltas, provider-executed tools, reasoning parts with provider metadata, `inputTokens.cacheRead/cacheWrite`, file parts, `raw` chunks) [AI-npm][AI-scan][AI-spec-stream][AI-spec-usage].
4. **Cloudflare AI Gateway sits under either adapter as configuration, not code**: for the direct adapter it is `baseURL = https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` plus `cf-aig-*` headers (BYOK removes the provider key entirely) [AIG-anthropic][AIG-byok][AIG-headers]; for the AI SDK adapter it is Cloudflare's `ai-gateway-provider` wrapper (`createAiGateway({accountId, gateway, apiKey})(anthropic(...))`), which is the documented integration — a bare `baseURL` override is not [AIG-vercel][AIG-provider-pkg]. Per-Scope custom metadata (max 5 entries), cache, retries, timeouts and spend limits are all headers or dashboard config [AIG-metadata][AIG-request].

Why not pick one library:

- **AI SDK only** would work on Workers today and its `providerOptions.anthropic` surface is remarkably complete (adaptive thinking, `effort`, `fallbacks: 'default'`, `contextManagement` with `compact_20260112`, `mcpServers`, `taskBudget`, `toolStreaming`, `cacheControl`, `anthropicBeta`) [AI-anthropic-opts]. The costs are structural, not feature gaps: a new major every 5–8 months (4.0 2024-11-18, 5.0 2025-07-31, 6.0 2025-12-22, 7.0 2026-06-25) each renaming message/usage/stream types [AI-npm][AI-mig5][AI-mig6][AI-mig7]; a persisted transcript in `ModelMessage` shape would be coupled to that churn; Anthropic-specific response blocks (`compaction`, `fallback`, `server_tool_use`/`*_tool_result`, `mcp_tool_use`) surface only through `providerMetadata`/`raw` and their exact stream representation is not documented (UNVERIFIED, section 2.1); and the SDK's core rejects `system` inside `messages` unless `allowSystemInMessages` is set [AI-prompts][AI-anthropic-src].
- **pi-ai only** is the closest existing design to what karmi wants (a `Message` union with `toolResult` role, `AssistantMessageEvent` deltas, `Usage` with `cacheRead/cacheWrite/cost`, browser-safe lazy-loaded API modules, cross-provider `transformMessages`) and it is very much alive (0.84.3 on 2026-08-24, weekly releases, 126 authors on `packages/ai`) [PI-readme][PI-types][PI-transform][PI-git]. But it pins its own copies of `@anthropic-ai/sdk 0.91.1`, `openai 6.40.0`, `@google/genai 1.52.0` and `@aws-sdk/client-bedrock-runtime` as hard dependencies (current majors are 0.122 / 7.8 / 2.19) [PI-pkg][AN-sdk-npm][OA-npm][GG-npm]; it does not expose compaction/`context_management`, server tools, the MCP connector or `disable_parallel_tool_use` [PI-anthropic]; and its `AssistantMessage` embeds provider/model/cost fields that karmi should compute itself. Copy its transform rules; do not import it.
- **A gateway only** (Cloudflare Unified/REST API or OpenRouter) is an OpenAI-shaped wire format. Cloudflare's `/ai/v1/messages` REST route does keep Anthropic's schema [AIG-rest], and OpenRouter forwards `cache_control` on content parts and preserves thinking signatures through `reasoning_details` [OR-cache][OR-reasoning]; but neither documents Anthropic `fallbacks`, `context_management`, MCP connector or `anthropic-beta` passthrough (UNVERIFIED), and OpenRouter's tool-result content is a string [OR-tools]. Gateways are a transport layer for karmi, not the seam.

Trade-offs accepted: two conversion layers (internal ↔ Anthropic, internal ↔ AI SDK spec) to keep in step; a second copy of "tool call id normalisation, thinking-block stripping on model switch" logic that pi already wrote; the AI SDK adapter will lag the direct adapter on brand-new Anthropic features by however long `@ai-sdk/anthropic` takes (historically days to weeks: `effort` landed 3.0.0 on 2025-12-22, compaction 3.0.41 on 2026-02-10, `eagerInputStreaming` 3.0.58 on 2026-03-05, `fallbacks` 4.0.0 on 2026-06-25) [AI-anthropic-changelog].

What would change this recommendation: (a) if the AI SDK froze `LanguageModelV4` and `ModelMessage` for a multi-year window and documented the stream representation of Anthropic's compaction/fallback/server-tool blocks, an AI-SDK-only adapter set would be enough and the direct adapter could be dropped; (b) if karmi's users turn out to be overwhelmingly Anthropic-only, the AI SDK adapter could be deferred and Workers AI / OpenAI reached through Cloudflare's `/ai/v1/messages` Anthropic-schema route instead [AIG-rest]; (c) if pi-ai un-pins the official SDKs into peer dependencies and drops the AWS SDK from the default graph, it becomes a viable breadth adapter with a better event model than the AI SDK spec.

## 2. Candidate-by-candidate evaluation

### 2.1 (a) Vercel AI SDK (`ai` 7.0.84 + `@ai-sdk/*` + `@ai-sdk/gateway`)

| Dimension | Finding | Source |
|---|---|---|
| 1 Coverage | First-party: `@ai-sdk/anthropic` 4.0.45, `@ai-sdk/openai` 4.0.51 (Responses is the default `openai(model)`; Chat via `openai.chat()`; Azure defaulted to Responses in v6), `@ai-sdk/google` 4.0.57, `@ai-sdk/google-vertex` 5.0.69 (`/edge` entry with `googleCredentials`; main entry pulls `google-auth-library`), `@ai-sdk/amazon-bedrock` 5.0.67 (fetch-based `aws4fetch` signing), `@ai-sdk/openai-compatible` 3.0.40. Workers AI via Cloudflare's `workers-ai-provider` 4.0.0 (MIT, peer `ai ^7`, binding or REST, `gateway: {id}`) | [AI-providers][AI-mig6][AI-npm][WAI-provider] |
| 2 Tool fidelity | Parallel calls; `strict` per tool; `toModelOutput` returns content arrays incl. `file` parts (images) for tool results; Anthropic conversion sets `is_error` from `error-text`/`error-json`; spec stream parts `tool-input-start/delta/end` for partial JSON; provider-executed tools flagged `providerExecuted: true` (Anthropic `webSearch_20250305`, `webFetch_20250910`, `codeExecution_20260120`, `computer_20251124`, `memory_20250818`, `toolSearch*`; OpenAI `webSearch`, `fileSearch`, `codeInterpreter`, `imageGeneration`, `computer`, `mcp`); `dynamicTool()`; `execute` optional so calls can be forwarded | [AI-tools][AI-spec-stream][AI-anthropic-src][AI-anthropic][AI-openai] |
| 3 Streaming on Workers | No first-party Workers page; `ai` dist has zero `node:` imports, only a guarded `process.getBuiltinModule` probe; `@ai-sdk/provider-utils` loads `undici`/`node:dns` only inside `createSafeNodeFetch()` gated by `isNodeRuntime()`; SSE parsed by `eventsource-parser`. Known issues: #10725 `streamText()` tee deadlock on Workers (closed 2025-12-01), #2741 implicit `Buffer` (closed), #11408 devtools on Workers (open), #16753 `textStream` tee retains output in memory (open). `engines.node >=22` is metadata only | [AI-scan][AI-cf-issues][AI-npm] |
| 4 Multimodal | Input `file` parts: Google (PDF/image/audio/video/YouTube), Anthropic (image, PDF), OpenAI (image, PDF, wav/mp3), Bedrock (image, PDF). Output: `generateImage`, `generateSpeech`, `transcribe` (all stable in v7), Gemini image via `providerOptions.google.responseModalities` → `result.files`, OpenAI `openai.tools.imageGeneration()` | [AI-prompts][AI-image][AI-speech][AI-google][AI-openai] |
| 5 Caching | `providerOptions.anthropic.cacheControl {type:'ephemeral', ttl?: '5m'|'1h'}` per message/part; usage `inputTokenDetails.cacheReadTokens/cacheWriteTokens` (spec `inputTokens.{noCache,cacheRead,cacheWrite}`); `cache_creation_input_tokens` removed from `providerMetadata` in 4.0.0; OpenAI/Gemini automatic caching flows into the same fields | [AI-anthropic-opts][AI-spec-usage][AI-anthropic-changelog] |
| 6 Anthropic features | `thinking: {type:'adaptive', display?}` (also `enabled`/`disabled`), `effort: low|medium|high|xhigh|max`, `fallbacks: 'default' | [{model,…}]`, `contextManagement.edits[]` incl. `compact_20260112`, `mcpServers`, `container`, `taskBudget`, `toolStreaming` (supersedes `eagerInputStreaming`), `structuredOutputMode`, `anthropicBeta: string[]`, `disableParallelToolUse`, `speed`, `inferenceGeo`. Stop: `refusal` → `content-filter`, `pause_turn` handled, `providerMetadata.anthropic.stopDetails/iterations/contextManagement.appliedEdits`. Reasoning replay: `signature_delta` → `providerMetadata.anthropic.signature`, `redacted_thinking` → `redactedData`, converted back on the next call; assistant parts are converted in order (no reordering found — UNVERIFIED beyond source reading). Mid-conversation system: emitted as `role:'system'` with beta `mid-conversation-system-2026-04-07` but only when core is given `allowSystemInMessages: true`. **Not documented**: how a `compaction` or `fallback` content block appears in the stream (likely `raw` or dropped — UNVERIFIED) | [AI-anthropic-opts][AI-anthropic-src][AI-anthropic-changelog][AI-prompts] |
| 7 Config switching | Every `create*` accepts `baseURL`, `apiKey`, `headers`, `fetch`; per-call `headers`. Cloudflare AI Gateway: use `ai-gateway-provider` (`createAiGateway`, fallback arrays, `skipCache/cacheTtl/cacheKey`, metadata, retries), not a `baseURL` override. Vercel AI Gateway: `@ai-sdk/gateway` 4.0.68, `AI_GATEWAY_API_KEY` works off-Vercel, per-request `providerOptions.gateway.byok`, `order/only/sort`, `models` fallbacks; source posts the whole call options body so `anthropic.cacheControl` is forwarded (inference from source) | [AI-settings][AIG-vercel][AIG-provider-pkg][AI-gateway] |
| 8 Bundle / Workers | `ai` 95.2 KB gz (384 KB min); `@ai-sdk/anthropic` 37.2 KB; `@ai-sdk/openai` 51.3 KB; `@ai-sdk/gateway` 30.2 KB; `zod` peer (`^3.25.76 || ^4.1.8`) 61.8 KB; `@ai-sdk/provider-utils` depends on `undici ^7` (tree-shaken/lazy); ESM-only; Workers script cap 3 MB free / 10 MB paid compressed | [AI-sizes][AI-npm][W-limits] |
| 9 Loop ownership | `generateText/streamText` run a multi-step loop (`stopWhen`, `prepareStep`, `activeTools`), `ToolLoopAgent` "stateless between calls" with messages passed per call; the loop stops when a tool has no `execute`. Single-call layer is `LanguageModel.doStream()` from `@ai-sdk/provider`. `ModelMessage` is JSON-safe only if file data is base64/URL (not stated as a guarantee — UNVERIFIED). v7 stream parts: `start, start-step, text-*, reasoning-*, tool-input-*, tool-call, tool-result, tool-error, tool-approval-*, source, file, finish-step, finish, abort, error, raw` | [AI-agents][AI-generate][AI-modelmsg][AI-stream-parts] |
| 10 Maintenance | Apache-2.0; ~daily patches on 7.x (82 stable `ai` releases in Aug 2026), three majors (5.x/6.x/7.x) patched in parallel; spec `LanguageModelV2`→`V3` (v6)→`V4` (v7) | [AI-license][AI-npm][AI-mig6][AI-mig7] |

### 2.2 (b) Cloudflare AI Gateway (provider-native routes, REST API, Unified API)

| Dimension | Finding | Source |
|---|---|---|
| 1 Coverage | 24 provider slugs incl. `anthropic`, `openai` (`/chat/completions` and `/responses`), `google-ai-studio`, `google-vertex-ai`, `aws-bedrock` (BYOK does SigV4), `workersai`, `openrouter`; **custom providers** for any HTTPS OpenAI-compatible base URL (`custom-{slug}`). No generic "openai-compatible" slug page (404) | [AIG-providers][AIG-openai][AIG-bedrock][AIG-vertex][AIG-custom] |
| 2 Tool fidelity | Provider-native routes forward the provider's own JSON, so fidelity equals the provider's. The REST API adds `/ai/v1/messages` "strictly uses Anthropic's API schema" (routes Anthropic and other third-party models; `@cf/` models excluded), `/ai/v1/responses`, `/ai/v1/chat/completions`. Limitations of the (deprecated) `/compat/chat/completions` for tools/images/`cache_control`/`thinking` are not listed — UNVERIFIED | [AIG-rest][AIG-compat] |
| 3 Streaming | SSE chunks "forwarded to the client as they arrive"; Guardrails and DLP buffer the full response and disable incremental delivery; `cf-aig-request-timeout` fires on first byte for streams | [AIG-dlp][AIG-guardrails][AIG-request] |
| 4 Multimodal | Pass-through of whatever the provider route accepts; Workers AI image gen (`flux-*`), STT (`whisper*`, `nova-3`), TTS (`aura-*`, `melotts`) via the `workersai` slug or binding | [WAI-models] |
| 5 Caching | Gateway response cache (SHA-256 of provider+endpoint+model+auth header+body; TTL 60 s–1 month; `cf-aig-cache-ttl/skip-cache/cache-key`) is orthogonal to provider prompt caching, which passes through untouched on native routes; whether cached entries serve streamed responses is not stated — UNVERIFIED | [AIG-caching] |
| 6 Anthropic features | Native `anthropic` route with `x-api-key` + `anthropic-version`; BYOK requires removing `x-api-key` ("adding your own `x-api-key` header will cause the request to fail"). `anthropic-beta` header passthrough is not documented anywhere (the Claude Code integration page sets `ANTHROPIC_BASE_URL` to the gateway and Claude Code sends beta headers, which implies passthrough) — UNVERIFIED | [AIG-anthropic][AIG-byok][AIG-claude-code] |
| 7 Config switching | URL scheme `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}/...`; `cf-aig-authorization: Bearer {token}` (token with `AI Gateway Run` can hit every gateway in the account — cannot be scoped to one gateway); BYOK stored keys; `cf-aig-metadata` (5 entries, string/number/boolean, `cf.` prefix reserved); `cf-aig-request-timeout`, `cf-aig-max-attempts` (≤5), `cf-aig-retry-delay` (≤5000 ms), `cf-aig-backoff`; `cf-aig-collect-log[-payload]`, `cf-aig-custom-cost`, `cf-aig-event-id`, `cf-aig-log-id`; response `cf-aig-cache-status`, `cf-aig-step`, `cf-aig-dlp`. Fallback chains: Universal Endpoint (array of `{provider, endpoint, headers, query}`, **deprecated**) or Dynamic Routing (conditional/percentage/rate-limit/budget nodes, invoked as `model: "dynamic/{route}"` on `/compat`, "not currently available on the REST API"; GA status unstated). Workers AI binding: `env.AI.run(model, inputs, {gateway: {id, skipCache, cacheTtl}})` | [AIG-anthropic][AIG-auth][AIG-byok][AIG-metadata][AIG-headers][AIG-request][AIG-universal][AIG-dynamic][AIG-wai-binding] |
| 8 Bundle / Workers | Zero code; it is a URL. Gateway limits: 10 gateways free / 20 paid, 25 MB cacheable request, logs 10M per gateway paid / 100k per account free, 10 MB per log; overall max request body — UNVERIFIED | [AIG-limits] |
| 9 Loop ownership | None | — |
| 10 Maintenance | Core features free; persistent logs, DLP free; Guardrails billed as Workers AI (Llama Guard 3 8B, ~500 ms); Unified Billing 5% on credits; the docs moved endpoints twice in 15 months (Universal → `/compat` 2025-06-03 → REST API), so treat gateway URL shapes as config, never as code | [AIG-pricing][AIG-compat-changelog][AIG-universal] |

### 2.3 (c) OpenRouter

| Dimension | Finding | Source |
|---|---|---|
| 1 Coverage | `POST /api/v1/chat/completions` (OpenAI schema, ids `org/model`) and a **stateless** `/api/v1/responses` (`store`/`previous_response_id` → 400); routes to Anthropic, OpenAI, Google, Bedrock, Vertex, Azure and many open-weight hosts; no Workers AI | [OR-overview][OR-responses][OR-routing] |
| 2 Tool fidelity | OpenAI-format tools, `parallel_tool_calls`, streaming `delta.tool_calls`; tool result is `role:"tool"` with content "as a JSON string" — images in tool results not documented (pi-ai works around it by appending a user message "Attached image(s) from tool result") | [OR-tools][PI-openai-compl] |
| 3 Streaming | SSE with `: OPENROUTER PROCESSING` keep-alive comments to ignore; abort-to-cancel works for OpenAI/Anthropic upstreams, not Bedrock/Groq; usage in the last SSE chunk | [OR-streaming][OR-usage] |
| 4 Multimodal | Input: image, PDF (`file` part with parsing engines), audio (`input_audio`, base64), `video_url`; output: image generation (`/api/v1/images`, `b64_json`), TTS, async video | [OR-multimodal][OR-images] |
| 5 Caching | Anthropic `cache_control` on individual content parts (max 4 breakpoints, `ttl: "1h"`), plus top-level `cache_control` for automatic caching (Anthropic, Vertex, Azure, Bedrock); OpenAI/DeepSeek/Grok/Gemini automatic; `prompt_tokens_details.cached_tokens` + `cache_write_tokens`; Anthropic pricing multipliers passed through | [OR-cache] |
| 6 Anthropic features | Thinking via `reasoning: {effort: max…none, max_tokens, exclude}`; signatures preserved in `reasoning_details[]` (`reasoning.summary/encrypted/text` with `signature`) and must be replayed as a matching consecutive sequence; web search via `plugins: [{id:"web", engine:"native"}]`; MCP connector **not** supported server-side (docs convert MCP tools to function tools); `fallbacks`, `context_management`, `strict`, `stop_details`, task budgets: not mentioned — UNVERIFIED/unsupported | [OR-reasoning][OR-websearch][OR-mcp] |
| 7 Config switching | `provider: {order, allow_fallbacks, only, ignore, require_parameters, data_collection, zdr, sort, max_price}`, `models: [...]` fallback list, `:nitro`/`:floor` suffixes; BYOK at 5 % of normal cost after a $25k/mo allowance; `HTTP-Referer` and `X-OpenRouter-Title` attribution headers; reachable from Workers as plain `fetch`, also behind Cloudflare AI Gateway's `openrouter` slug | [OR-routing][OR-byok][OR-attrib][AIG-openrouter] |
| 8 Bundle / Workers | Raw fetch, or `@openrouter/ai-sdk-provider` 3.0.0 (peer `ai ^7`), or `@openrouter/sdk` 1.2.82 (ESM-only) | [OR-sdk-npm][OR-sdk] |
| 9 Loop ownership | None | — |
| 10 Maintenance | Commercial gateway; 5.5 % credit purchase fee, no inference markup; "zero logging" unless opted in; per-request `data_collection: "deny"` / `zdr` | [OR-faq][OR-privacy] |

### 2.4 (d) pi-ai (`@earendil-works/pi-ai` 0.84.3)

| Dimension | Finding | Source |
|---|---|---|
| 1 Coverage | Wire APIs: `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `pi-messages`; providers on top incl. Cloudflare AI Gateway, Cloudflare Workers AI, OpenRouter, Vercel AI Gateway, Groq, xAI, Cerebras, "any OpenAI-compatible API"; `createProvider({baseUrl, auth, models, api})` for custom ones | [PI-readme][PI-types] |
| 2 Tool fidelity | `ToolResultMessage.content: (Text|Image)[]` + `isError`; Anthropic adapter emits base64 image blocks inside `tool_result`; `toolcall_start/delta/end` events; `ToolCall.thoughtSignature` (Gemini); `compat.supportsStrictTools`; **no** `disable_parallel_tool_use`, no server tools, no MCP connector | [PI-types][PI-anthropic] |
| 3 Streaming on Workers | "The library supports browser environments. The core entrypoint and provider factories are side-effect free and bundle cleanly"; API implementations lazy-loaded (`*.lazy.ts`); `process.env` guarded; Node-only imports confined to `cli.ts` (`node:fs`), OAuth (`node:http`), `pi-user-agent.ts` (`node:os`) and Bedrock (`node:https`, not supported in browsers). Not tested on workerd by its authors (no statement) — UNVERIFIED | [PI-readme][PI-scan] |
| 4 Multimodal | Image input (`Model.input: ("text"|"image")[]`, images replaced by placeholder text for non-vision models); no audio/video/PDF types in `Message`; no generation APIs | [PI-types][PI-transform] |
| 5 Caching | Automatic: `cache_control` placed on system blocks, on the last block of the last message, and on the last tool; `cacheRetention: "long"` → `ttl: "1h"` when `compat.supportsLongCacheRetention`; `Usage {input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost{…}}`. No explicit breakpoint API | [PI-anthropic][PI-types] |
| 6 Anthropic features | Wraps `@anthropic-ai/sdk` (`client.messages.create({...,stream:true}).asResponse()`); `forceAdaptiveThinking` → `thinking: {type:"adaptive", display}`; `effort` → `output_config.effort`; `allowedFallbackModels` → `fallbacks` + beta `server-side-fallback-2026-07-01`; betas `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14`; thinking replay with signatures, `redacted_thinking`, unsigned thinking downgraded to text unless `allowEmptySignature`. **Missing**: compaction/`context_management`, `role:"system"` mid-conversation, server tools, MCP connector, `stop_details`, task budgets, `count_tokens` | [PI-anthropic] |
| 7 Config switching | `models.getModel(provider, id)`; per-model `baseUrl`/`headers`; `transformHeaders` hook ("provider auth headers → model.headers → options.headers → transformHeaders"); dedicated Cloudflare AI Gateway API module; OpenRouter `provider` routing via `compat.openRouterRouting` | [PI-readme][PI-openai-compl] |
| 8 Bundle / Workers | 4.1 MB unpacked (bundlephobia UNVERIFIED); hard deps `@anthropic-ai/sdk 0.91.1`, `openai 6.40.0`, `@google/genai 1.52.0`, `@aws-sdk/client-bedrock-runtime 3.1048.0`, `@smithy/node-http-handler`, `http-proxy-agent`, `https-proxy-agent`, `partial-json`, `typebox`, `@earendil-works/pi-telemetry`; `engines.node >=22.19.0`; ESM-only | [PI-pkg][PI-npm] |
| 9 Loop ownership | None in pi-ai: `models.stream()`/`complete()`/`streamSimple()` are single calls; `@earendil-works/pi-agent-core` depends on pi-ai, never the reverse; README tool-handling examples are pure pi-ai | [PI-readme][PI-agent-pkg] |
| 10 Maintenance | MIT; renamed from `@mariozechner/pi-ai` (0.73.1, deprecated 2026-05-07) to `@earendil-works/pi-ai`; v0.84.3 2026-08-24, roughly weekly tags; 1,763 commits / 126 authors on `packages/ai`, top-5 authors hold ~87 % (Zechner 1,177, Ronacher 203, Brailovsky 62, Stikbakke 42, Poncela 38) — last 90 days more evenly spread; still 0.x, no stability statement | [PI-npm-old][PI-npm][PI-git] |

### 2.5 (e) Thin own adapters over official SDKs / raw fetch

| Dimension | Finding | Source |
|---|---|---|
| 1 Coverage | `@anthropic-ai/sdk` 0.122.0 (MIT; `@anthropic-ai/vertex-sdk` 0.19.6, `@anthropic-ai/bedrock-sdk` 0.33.3 pull `google-auth-library` / full AWS SDK v3); `openai` 7.8.0 (Apache-2.0, zero runtime deps, Responses + Chat); `@google/genai` 2.19.0 (Apache-2.0; deps `ws`, `protobufjs`, `google-auth-library`, `p-retry`; `enterprise: true` replaces `vertexai: true`); Workers AI via `env.AI.run()` or the OpenAI-compatible `/ai/v1/chat/completions`; generic OpenAI-compatible via `openai` with `baseURL` | [AN-sdk-npm][OA-npm][GG-npm][GG-client][WAI-openai] |
| 2 Tool fidelity | Full: Anthropic `tool_result.content` arrays (`text`, `image`, `document`, `search_result`), `is_error`, parallel `tool_use` blocks, `tool_choice.disable_parallel_tool_use`, `strict: true`, per-tool `eager_input_streaming`; OpenAI Responses `function_call_output` may be an array of image/file objects, `strict`, `parallel_tool_calls`, hosted tools; Chat Completions tool content is text-only; Gemini `functionResponse.parts` may carry images/PDF, `thought_signature` must be replayed in its original part | [AN-tool-results][AN-parallel][AN-structured][AN-eager][OA-functions][OA-chat][GG-functions] |
| 3 Streaming on Workers | Anthropic SDK and `openai` both list "Cloudflare Workers" as supported runtimes and are fetch-based with `fetch`/`fetchOptions` overrides; Node built-ins confined to opt-in modules (Anthropic: credentials/file-store/agent-toolset/memory; openai: x509/subject-token/audio helpers); `@google/genai` selects `dist/web` under the `browser` export condition but does not mention Workers — UNVERIFIED. workerd ships `ReadableStream`/`TransformStream`/`TextDecoderStream` and a native `EventSource.from(readableStream)`; `nodejs_compat` is on by default for compatibility dates ≥ 2026-08-04 | [AN-sdk][OA-readme][AN-sdk-scan][OA-scan][GG-scan][W-streams][W-eventsource][W-nodejs] |
| 4 Multimodal | Anthropic: image (`base64`/`url`/`file`), PDF document, Files API GA; text output only ("cannot generate images"); no audio/video input found (UNVERIFIED negative). OpenAI: image/PDF/audio in, `image_generation` tool out. Gemini: text/image/audio/video/PDF in, `responseModalities: ["TEXT","IMAGE"]` out | [AN-vision][AN-pdf][AN-files][OA-images][GG-image-out][GG-audio] |
| 5 Caching | Anthropic `cache_control` (4 breakpoints; tools → system → messages; top-level automatic mode; usage `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`; min 512–4,096 tokens by model); OpenAI automatic (`prompt_cache_key`, `usage.input_tokens_details.cached_tokens`/`cache_write_tokens`); Gemini implicit by default plus explicit `cachedContents`, `usageMetadata.cachedContentTokenCount` | [AN-cache][OA-cache][GG-cache] |
| 6 Anthropic features | Everything, on release day, via `client.beta.messages.create({betas: [...]})`. Current status: adaptive thinking the only mode on 4.7+ (`enabled` rejected with 400), thinking on by default on Fable 5/Opus 5/Sonnet 5, `display: summarized|omitted`, replay "complete and unmodified", strip on model switch (other models "silently ignore" foreign blocks but bill them); `output_config.effort` GA (`low…max`; changing it invalidates cache); `fallbacks: "default"` beta `server-side-fallback-2026-07-01`, only classifier refusals trigger it, served model in top-level `model` + `usage.iterations`, streaming emits a `fallback` content block; compaction beta `compact-2026-01-12` → `{"type":"compaction"}` block that must be replayed (everything before it ignored), default trigger 150k tokens; `role:"system"` mid-conversation GA on Fable 5/Mythos 5/Opus 4.8/Opus 5, not Sonnet 5, placement rules; `strict: true` and `output_config.format` GA; `eager_input_streaming` per tool GA; stop reasons `end_turn|max_tokens|stop_sequence|tool_use|pause_turn|refusal|model_context_window_exceeded` with `stop_details` only for `refusal`; task budgets beta `task-budgets-2026-03-13` (`output_config.task_budget`, min 20k, advisory); server tools `web_search_20260318`, `web_fetch_20260318`, `code_execution_20260521` (no header) with `encrypted_content` that must be replayed byte-exact; MCP connector beta `mcp-client-2025-11-20` with `mcp_toolset`; `count_tokens` GA | [AN-think][AN-ext][AN-effort][AN-fallback][AN-compact][AN-midsys][AN-structured][AN-eager][AN-stop][AN-budget][AN-server-tools][AN-websearch][AN-code-exec][AN-mcp][AN-count] |
| 7 Config switching | `new Anthropic({baseURL, defaultHeaders, fetch})` → gateway; `new OpenAI({baseURL})`; `new GoogleGenAI({httpOptions: {baseUrl}})`; all three documented against Cloudflare AI Gateway | [AIG-anthropic][AIG-openai][AIG-google] |
| 8 Bundle / Workers | Anthropic SDK 50.0 KB gz (185 KB min, 2 deps: `standardwebhooks`, `json-schema-to-ts`); `openai` 65.0 KB gz; `@google/genai` 64.1 KB gz; all far under the 10 MB script cap and irrelevant to the 128 MB isolate | [AN-sdk-npm][OA-npm][GG-npm][W-limits] |
| 9 Loop ownership | None; `client.messages.stream()` and `client.beta.messages.toolRunner()` are opt-in helpers | [AN-sdk] |
| 10 Maintenance | Anthropic SDK 0.x but published 2026-08-27 with 0.115→0.122 in the sibling constraints, i.e. frequent minors; `openai` 7.x; `@google/genai` 2.x with 3.0 announced to require Node 22; Gemini's `generateContent` is "legacy" (fully supported) with the Interactions API "recommended for all new projects" since June 2026 | [AN-sdk-npm][OA-npm][GG-readme][GG-interactions] |

### 2.6 The hybrid, weighed honestly

The hybrid is (e) for Anthropic plus (a)'s spec layer for breadth, under one internal schema, with (b) as optional transport. What it costs versus AI-SDK-only: a second adapter (~the size of pi's `anthropic-messages.ts`, 1,400 lines [PI-anthropic]) and a second set of conformance tests. What it buys: the persisted transcript and event log are karmi's types; Anthropic's stream-level blocks (`compaction`, `fallback`, `server_tool_use`, `mcp_tool_use`, `redacted_thinking`) are first-class rather than `raw`; feature latency for the primary provider is zero; and the AI SDK can be upgraded (or removed) without a data migration. What it costs versus pi-ai: re-implementing `transformMessages` (same-model check, thinking strip, id normalisation, orphaned tool-call repair, non-vision image placeholders) [PI-transform] — but that logic must live in the Harness anyway, because it depends on the model recorded in each persisted message.

## 3. Comparison matrix

| Dimension | (a) AI SDK | (b) CF AI Gateway | (c) OpenRouter | (d) pi-ai | (e) Own over official SDKs | Hybrid |
|---|---|---|---|---|---|---|
| 1 Coverage | All 6 targets + Bedrock/Vertex first-party; Workers AI via Cloudflare provider | 24 slugs + custom; native Anthropic/OpenAI/Gemini/Workers AI routes | No Workers AI; everything else | All 6 + Bedrock/Vertex; OAuth extras | Per-SDK; Bedrock/Vertex need sibling SDKs | All (via a) |
| 2 Tool fidelity | High; provider-executed flagged; images in results | = provider on native routes | Text-only tool results; no MCP connector | Images in results; no server tools/MCP | Full | Full for Anthropic; high elsewhere |
| 3 Workers streaming | Runs; two closed Workers issues, one open memory issue | Native SSE passthrough (DLP/Guardrails buffer) | SSE + keep-alive comments | Browser-safe by design; workerd UNVERIFIED | Anthropic/openai list Workers; genai UNVERIFIED | Same as a + e |
| 4 Multimodal in/out | In: all; out: image/speech/transcribe | Passthrough | In: img/PDF/audio/video; out: image/TTS/video | Image in only | Full per provider | Full |
| 5 Caching | `cacheControl` + cache usage fields | Response cache only; provider cache passthrough | `cache_control` on parts; cached/cache_write tokens | Automatic breakpoints; cacheRead/Write/1h | Full | Full |
| 6 Anthropic surface | Near-complete via `providerOptions`; block-level stream shape UNVERIFIED; system-in-messages gated | Passthrough; `anthropic-beta` UNVERIFIED | Thinking + effort + cache; no fallbacks/compaction/MCP | Adaptive, effort, fallbacks, cache; no compaction/MCP/server tools | Complete | Complete |
| 7 Config switching | `baseURL/headers/fetch`; `ai-gateway-provider`; Vercel gateway BYOK/order | URL + `cf-aig-*` headers + BYOK + Dynamic Routing | `provider`/`models` routing | `baseUrl/headers/transformHeaders` | `baseURL/defaultHeaders/fetch` | Config object → adapter + gateway (section 4) |
| 8 Bundle (gz) | 95 + 37 + 51 + 62 (zod) KB | 0 | 0 (fetch) | 4.1 MB unpacked + 4 vendor SDKs | 50 / 65 / 64 KB | ~50 KB (Anthropic) + AI SDK only when enabled |
| 9 Loop | Wants it (`streamText`, `ToolLoopAgent`); `doStream` usable alone | None | None | None (agent-core separate) | None | karmi owns it |
| 10 Maintenance | Apache-2.0; majors every 5–8 months; daily patches | Endpoints deprecated twice in 15 months | Commercial; fees | MIT; weekly; 0.x; pinned vendor SDKs | MIT/Apache; SDK-paced | Two adapters to track |

## 4. Interface sketch

The internal schema is deliberately closer to pi-ai's `Message`/`AssistantMessageEvent` than to the AI SDK's `ModelMessage`/stream parts, because pi's shape has a `toolResult` role with `content[]`+`isError` and per-block signatures [PI-types], which is what the Anthropic, Responses and Gemini wire formats all need replayed [AN-think][OA-state][GG-functions]. All types are plain JSON so a DO can persist every event to SQLite and rebuild the request after eviction [RC §6.3].

```ts
// ---- Config, resolved per Scope (secrets come from the Scope's store, never inline) ----
export type GatewayConfig =
  | { kind: "cloudflare"; accountId: string; gatewayId: string; token: SecretRef;      // cf-aig-authorization
      byok?: boolean; metadata?: Record<string, string | number | boolean>;            // max 5 entries [AIG-metadata]
      cache?: { ttl?: number; skip?: boolean; key?: string };
      retry?: { maxAttempts?: 1|2|3|4|5; delayMs?: number; backoff?: "constant"|"linear"|"exponential" };
      timeoutMs?: number }
  | { kind: "vercel"; apiKey: SecretRef; order?: string[]; only?: string[] }
  | { kind: "openrouter"; apiKey: SecretRef; provider?: { order?: string[]; allow_fallbacks?: boolean } }
  | { kind: "none" };

export interface ProviderConfig {
  provider: "anthropic" | "openai" | "google" | "workers-ai" | "openai-compatible" | "bedrock" | "vertex";
  model: string;                                  // provider-native id, e.g. "claude-fable-5"
  adapter?: "direct" | "ai-sdk";                  // default: "direct" for anthropic, "ai-sdk" otherwise
  apiKey?: SecretRef;                             // omitted when gateway.byok is true
  baseURL?: string;                               // openai-compatible / self-hosted
  gateway?: GatewayConfig;
  providerOptions?: ProviderOptions;              // escape hatch, see below
}

// ---- Internal messages (persisted) ----
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data?: string; url?: string; ref?: string }   // ref = R2 pointer [RC §6.1]
  | { type: "document"; mediaType: "application/pdf" | "text/plain"; data?: string; url?: string; ref?: string }
  | { type: "thinking"; text: string; signature?: string; redacted?: boolean; model: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; thoughtSignature?: string }
  | { type: "server_tool_call"; id: string; name: string; input: unknown }             // provider-executed
  | { type: "server_tool_result"; toolCallId: string; raw: unknown }                   // replayed byte-exact [AN-websearch]
  | { type: "compaction"; content: string }                                            // [AN-compact]
  | { type: "provider"; provider: string; raw: unknown };                              // anything else, replayed as-is

export type Message =
  | { role: "system"; content: string; position?: "top" | "inline" }                   // inline = mid-conversation [AN-midsys]
  | { role: "user"; content: ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[]; model: string; provider: string; stopReason: StopReason }
  | { role: "tool_result"; toolCallId: string; content: ContentBlock[]; isError: boolean };

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "pause_turn" | "refusal"
  | "context_window_exceeded" | "error" | "aborted";

export interface Usage {
  input: number; output: number; reasoning?: number;
  cacheRead: number; cacheWrite: number; cacheWrite1h?: number;                        // [AN-cache][OA-cache][GG-cache]
  iterations?: Array<{ type: "message" | "compaction" | "fallback_message"; model?: string }>;  // [AN-fallback][AN-compact]
  raw?: unknown;
}

// ---- Request and stream vocabulary ----
export interface ProviderRequest {
  config: ProviderConfig;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];                                                                   // { name, description, inputSchema, strict?, eagerInputStreaming?, cache? }
  toolChoice?: "auto" | "any" | "none" | { name: string };
  parallelToolCalls?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  providerOptions?: ProviderOptions;                                                   // merged over config.providerOptions
}

// Maps onto the three-level stream: turn (Harness) > message > delta [HB §2.3]
export type ProviderEvent =
  | { type: "message_start"; model: string; responseId?: string }
  | { type: "block_start"; index: number; block: ContentBlock }                         // partial block, e.g. tool_call with name only
  | { type: "text_delta"; index: number; delta: string }
  | { type: "thinking_delta"; index: number; delta: string }
  | { type: "signature"; index: number; signature: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }                    // may be invalid JSON mid-stream [AN-eager]
  | { type: "block_end"; index: number; block: ContentBlock }                           // final, complete block
  | { type: "message_end"; stopReason: StopReason; stopDetails?: unknown; usage: Usage; message: Message }
  | { type: "error"; error: { code: string; message: string; retryable: boolean; raw?: unknown } }
  | { type: "raw"; raw: unknown };                                                     // opt-in provider event passthrough

export interface Provider {
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  countTokens?(request: ProviderRequest): Promise<number>;                              // Anthropic count_tokens [AN-count]; others estimate
}

// ---- Escape hatch: namespaced, JSON, forwarded verbatim by the matching adapter ----
export interface ProviderOptions {
  anthropic?: {
    thinking?: { type: "adaptive"; display?: "summarized" | "omitted" } | { type: "disabled" };
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    fallbacks?: "default" | Array<{ model: string; max_tokens?: number }>;
    contextManagement?: { edits: Array<{ type: "compact_20260112" | "clear_tool_uses_20250919" | "clear_thinking_20251015"; trigger?: unknown }> };
    taskBudget?: { type: "tokens"; total: number };
    cacheControl?: { system?: boolean; tools?: boolean; lastMessage?: boolean; ttl?: "5m" | "1h" } | { type: "automatic" };
    serverTools?: Array<{ type: string; name: string; [k: string]: unknown }>;        // web_search_20260318 etc.
    mcpServers?: Array<{ type: "url"; url: string; name: string; authorization_token?: string }>;
    betas?: string[];
  };
  openai?: { reasoning?: { effort?: string; summary?: string }; store?: false; include?: string[]; promptCacheKey?: string; hostedTools?: unknown[] };
  google?: { thinkingLevel?: string; thinkingBudget?: number; cachedContent?: string; responseModalities?: string[] };
  aiSdk?: Record<string, unknown>;                                                     // passed straight to LanguageModel providerOptions
  headers?: Record<string, string>;                                                    // adapter-level, after gateway headers
}
```

Example: the same agent, four configs. Only `ProviderConfig` changes; the `Provider` picked is `DirectAnthropicProvider` for the first two and `AiSdkProvider` for the last two.

```ts
const base = { providerOptions: { anthropic: {
  thinking: { type: "adaptive" }, effort: "high", fallbacks: "default",
  cacheControl: { system: true, tools: true, lastMessage: true, ttl: "1h" },
  betas: ["server-side-fallback-2026-07-01"] } } };

// 1. Anthropic direct
const a: ProviderConfig = { provider: "anthropic", model: "claude-fable-5", apiKey: secret("ANTHROPIC"), ...base };

// 2. Anthropic via Cloudflare AI Gateway, BYOK (no provider key in the Worker at all)
//    -> new Anthropic({ baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
//                       defaultHeaders: { "cf-aig-authorization": `Bearer ${token}`, "cf-aig-metadata": JSON.stringify({ scope }) } })
const b: ProviderConfig = { ...a, apiKey: undefined,
  gateway: { kind: "cloudflare", accountId, gatewayId, token: secret("CF_AIG"), byok: true, metadata: { scope: scopeId } } };

// 3. OpenAI Responses via Cloudflare AI Gateway (AI SDK adapter; wrapped with ai-gateway-provider [AIG-vercel])
const c: ProviderConfig = { provider: "openai", model: "gpt-5.2", adapter: "ai-sdk",
  gateway: b.gateway, providerOptions: { openai: { reasoning: { effort: "high" }, store: false, include: ["reasoning.encrypted_content"] } } };

// 4. Workers AI through the binding (AI SDK adapter over workers-ai-provider; gateway id passed as `gateway: { id }` [AIG-wai-binding])
const d: ProviderConfig = { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b", adapter: "ai-sdk",
  gateway: { kind: "cloudflare", accountId, gatewayId, token: secret("CF_AIG") } };
```

Adapter responsibilities (both adapters, enforced by one shared conformance test suite):

- **Replay rules** run in the Harness before either adapter, keyed on `Message.model`/`provider` (pi's `transformMessages` rules [PI-transform]): keep `thinking` blocks with signatures only for the same model, otherwise drop them (Anthropic bills ignored foreign blocks; modified ones are rejected with 400) [AN-think]; replay `compaction`, `server_tool_result` and `provider` blocks byte-exact; normalise tool-call ids across providers; insert error `tool_result`s for orphaned calls; place inline `system` messages only where Anthropic allows them [AN-midsys].
- **Direct Anthropic adapter**: `client.beta.messages.create({stream: true, betas})`; maps `message_start/content_block_start/delta/stop/message_delta/message_stop` [AN-streaming] onto `ProviderEvent`; surfaces `fallback` and `compaction` blocks as `block_*` events; applies `cacheControl` breakpoints in the documented order (tools → system → messages) [AN-cache]; `countTokens` calls `/v1/messages/count_tokens` [AN-count].
- **AI SDK adapter**: builds a `LanguageModelV4` from the provider factory (or `createAiGateway(...)(model)` / `createWorkersAI({binding}).chat(model)`), converts `Message[]` to the spec prompt, calls `doStream()`, and maps `text-*`, `reasoning-*` (+ `providerMetadata.anthropic.signature`), `tool-input-*`, `tool-call` (`providerExecuted`), `tool-result`, `file`, `finish`, `raw` onto `ProviderEvent`; `providerOptions.aiSdk` is forwarded untouched; `include.rawChunks` is on so unknown provider blocks arrive as `raw` [AI-spec-stream][AI-mig7].

## 5. Open questions for later tickets

1. **Compaction ownership.** Anthropic's server-side compaction (beta) emits a `compaction` block the transcript must replay [AN-compact]; OpenAI's Codex does remote compaction via Responses [HB §2.4]; Gemini has none. Is compaction a Harness step that may *delegate* to the provider (`providerOptions.anthropic.contextManagement`) and record the returned block, or always client-side? The internal schema reserves the `compaction` block either way.
2. **Provider-executed tools vs Harness tools.** Anthropic server tools and OpenAI hosted tools run inside the provider turn, bypass the Harness's permission gate and parallelism rules, and their results must be replayed `encrypted_content`-exact [AN-server-tools][AN-websearch]. Should they be a Capability granted per Scope (they cost money and egress) and how does the event log show them (`server_tool_call` events without a `tool_execution_*` pair)?
3. **MCP connector vs Harness-side MCP.** Anthropic's connector (beta `mcp-client-2025-11-20`) makes the provider the MCP client; the harness baseline decided on remote MCP consumed by the Harness [HB §3]. Supporting both means two credential paths for the same server. Which is default?
4. **AI SDK stream shape for Anthropic-only blocks** (`compaction`, `fallback`, `mcp_tool_use`) is UNVERIFIED; needs a spike against `@ai-sdk/anthropic` 4.0.x with `include.rawChunks`.
5. **`anthropic-beta` passthrough on Cloudflare AI Gateway's native route** is UNVERIFIED in docs; a one-request test decides whether config 2 above can carry `fallbacks`/compaction betas.
6. **Cloudflare Dynamic Routing vs REST API.** Fallback chains live only on the deprecated `/compat` path today [AIG-dynamic]; until the REST API covers it, gateway-level fallbacks are unavailable to the Anthropic-schema route, so provider-level `fallbacks: "default"` and Harness-level retry are the v0 mechanisms.
7. **Thinking on model switch.** Anthropic says strip foreign thinking; Gemini says resend all thought parts; OpenAI needs `encrypted_content` items. The replay rules need per-provider tests, and the persisted `thinking.model` field must be reliable.
8. **Token counting for compaction thresholds** without an Anthropic-style `count_tokens` on other providers: estimate from the last `Usage`, or call the provider with `max_tokens: 1`?
9. **Vercel AI Gateway** works from Workers with an API key [AI-gateway] but duplicates what Cloudflare AI Gateway does; keep `kind: "vercel"` in the config union or drop it for v0?
10. **Google Interactions API.** `generateContent` is "legacy" but supported; the AI SDK adapter targets whichever `@ai-sdk/google` uses (UNVERIFIED which). Revisit when Gemini thinking/caching semantics diverge between the two.

## 6. References

All URLs read 2026-08-29 unless noted.

Vercel AI SDK
[AI-npm]: https://registry.npmjs.org/ai (versions, `time`, `engines`, peer deps; majors 4.0.0 2024-11-18, 5.0.0 2025-07-31, 6.0.0 2025-12-22, 7.0.0 2026-06-25)
[AI-mig5]: https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0
[AI-mig6]: https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0
[AI-mig7]: https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
[AI-providers]: https://ai-sdk.dev/providers/ai-sdk-providers/ (anthropic, openai, google, google-vertex, amazon-bedrock, openai-compatible pages)
[AI-anthropic]: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
[AI-openai]: https://ai-sdk.dev/providers/ai-sdk-providers/openai
[AI-google]: https://ai-sdk.dev/providers/ai-sdk-providers/google
[AI-anthropic-opts]: https://github.com/vercel/ai/blob/main/packages/anthropic/src/anthropic-language-model-options.ts
[AI-anthropic-src]: https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts and .../anthropic-language-model.ts and .../convert-anthropic-usage.ts
[AI-anthropic-changelog]: https://github.com/vercel/ai/blob/main/packages/anthropic/CHANGELOG.md (dates cross-checked against https://registry.npmjs.org/@ai-sdk/anthropic)
[AI-tools]: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
[AI-spec-stream]: https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v4/language-model-v4-stream-part.ts (and v3 prompt/stream-part files)
[AI-spec-usage]: https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v4/language-model-v4-usage.ts
[AI-prompts]: https://ai-sdk.dev/docs/foundations/prompts
[AI-image]: https://ai-sdk.dev/docs/ai-sdk-core/image-generation
[AI-speech]: https://ai-sdk.dev/docs/ai-sdk-core/speech and https://ai-sdk.dev/docs/ai-sdk-core/transcription
[AI-agents]: https://ai-sdk.dev/docs/agents/building-agents and https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
[AI-generate]: https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text
[AI-modelmsg]: https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message
[AI-stream-parts]: https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text-result.ts and https://ai-sdk.dev/docs/ai-sdk-core/generating-text
[AI-settings]: https://ai-sdk.dev/docs/ai-sdk-core/settings and https://ai-sdk.dev/docs/ai-sdk-core/provider-management
[AI-gateway]: https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway and https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-language-model.ts
[AI-scan]: npm tarballs of `ai@7.0.84`, `@ai-sdk/provider-utils@5.0.33`, `@ai-sdk/anthropic@4.0.45` unpacked and grepped for `node:` imports (local scan, 2026-08-29)
[AI-cf-issues]: https://github.com/vercel/ai/issues/10725 , https://github.com/vercel/ai/issues/2741 , https://github.com/vercel/ai/issues/11408 , https://github.com/vercel/ai/issues/16753
[AI-sizes]: https://bundlephobia.com/api/size?package=ai (and `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/gateway`, `zod`); google/vertex/bedrock/openai-compatible sizes UNVERIFIED (HTTP 429)
[AI-license]: https://github.com/vercel/ai/blob/main/LICENSE

Cloudflare
[AIG-providers]: https://developers.cloudflare.com/ai-gateway/usage/providers/
[AIG-anthropic]: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
[AIG-openai]: https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
[AIG-google]: https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/
[AIG-bedrock]: https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/
[AIG-vertex]: https://developers.cloudflare.com/ai-gateway/usage/providers/vertex/
[AIG-openrouter]: https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/
[AIG-custom]: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
[AIG-compat]: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
[AIG-compat-changelog]: https://developers.cloudflare.com/changelog/post/2025-06-03-aig-openai-compatible-endpoint/
[AIG-rest]: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
[AIG-universal]: https://developers.cloudflare.com/ai-gateway/usage/universal/
[AIG-dynamic]: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/
[AIG-byok]: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
[AIG-auth]: https://developers.cloudflare.com/ai-gateway/configuration/authentication/
[AIG-headers]: https://developers.cloudflare.com/ai-gateway/glossary/ and https://developers.cloudflare.com/ai-gateway/observability/logging/
[AIG-metadata]: https://developers.cloudflare.com/ai-gateway/configuration/custom-metadata/
[AIG-request]: https://developers.cloudflare.com/ai-gateway/configuration/request-handling/
[AIG-caching]: https://developers.cloudflare.com/ai-gateway/features/caching/
[AIG-dlp]: https://developers.cloudflare.com/ai-gateway/features/dlp/
[AIG-guardrails]: https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/
[AIG-limits]: https://developers.cloudflare.com/ai-gateway/reference/limits/
[AIG-pricing]: https://developers.cloudflare.com/ai-gateway/reference/pricing/
[AIG-vercel]: https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/
[AIG-provider-pkg]: https://github.com/cloudflare/ai/tree/main/packages/ai-gateway-provider (README, package.json: v4.0.0, peer `ai ^7.0.11`)
[AIG-wai-binding]: https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/
[AIG-claude-code]: https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/
[WAI-models]: https://developers.cloudflare.com/workers-ai/models/ (plus model pages for `llama-4-scout-17b-16e-instruct`, `gpt-oss-120b`)
[WAI-openai]: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
[WAI-provider]: https://github.com/cloudflare/ai/blob/main/packages/workers-ai-provider/README.md and https://registry.npmjs.org/workers-ai-provider
[W-limits]: https://developers.cloudflare.com/workers/platform/limits/
[W-nodejs]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ and https://developers.cloudflare.com/workers/configuration/compatibility-flags/
[W-streams]: https://developers.cloudflare.com/workers/runtime-apis/streams/
[W-eventsource]: https://developers.cloudflare.com/workers/runtime-apis/eventsource/

OpenRouter
[OR-overview]: https://openrouter.ai/docs/api-reference/overview
[OR-responses]: https://openrouter.ai/docs/api-reference/responses/overview
[OR-routing]: https://openrouter.ai/docs/features/provider-routing
[OR-reasoning]: https://openrouter.ai/docs/use-cases/reasoning-tokens
[OR-cache]: https://openrouter.ai/docs/features/prompt-caching
[OR-usage]: https://openrouter.ai/docs/use-cases/usage-accounting
[OR-tools]: https://openrouter.ai/docs/guides/features/tool-calling
[OR-multimodal]: https://openrouter.ai/docs/features/multimodal/overview
[OR-images]: https://openrouter.ai/docs/features/multimodal/images
[OR-streaming]: https://openrouter.ai/docs/api-reference/streaming
[OR-byok]: https://openrouter.ai/docs/use-cases/byok
[OR-attrib]: https://openrouter.ai/docs/app-attribution
[OR-websearch]: https://openrouter.ai/docs/features/web-search
[OR-mcp]: https://openrouter.ai/docs/use-cases/mcp-servers
[OR-faq]: https://openrouter.ai/docs/faq
[OR-privacy]: https://openrouter.ai/docs/features/privacy-and-logging
[OR-sdk]: https://openrouter.ai/docs/sdks/typescript
[OR-sdk-npm]: https://registry.npmjs.org/@openrouter/ai-sdk-provider/latest and https://registry.npmjs.org/@openrouter/sdk/latest

pi (github.com/badlogic/pi-mono redirects to github.com/earendil-works/pi)
[PI-readme]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md
[PI-types]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/types.ts
[PI-anthropic]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/api/anthropic-messages.ts
[PI-transform]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/api/transform-messages.ts
[PI-openai-compl]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/api/openai-completions.ts
[PI-pkg]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/package.json
[PI-agent-pkg]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/agent/package.json and README.md
[PI-npm]: https://registry.npmjs.org/@earendil-works/pi-ai/latest (0.84.3)
[PI-npm-old]: https://registry.npmjs.org/@mariozechner/pi-ai/latest (0.73.1, deprecated notice "please use @earendil-works/pi-ai")
[PI-git]: local clone of earendil-works/pi at `6c87d9a`, `git log --no-merges -- packages/ai` and tags (2026-08-28/29)
[PI-scan]: grep of `packages/ai/src` for `node:` imports and `process.env` (local clone)

Anthropic (platform.claude.com)
[AN-think]: https://platform.claude.com/docs/en/build-with-claude/thinking
[AN-ext]: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
[AN-effort]: https://platform.claude.com/docs/en/build-with-claude/effort
[AN-fallback]: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
[AN-compact]: https://platform.claude.com/docs/en/build-with-claude/compaction and https://platform.claude.com/docs/en/build-with-claude/context-editing
[AN-midsys]: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages (the generic API reference at /docs/en/api/messages still says there is no system role; the feature page is more specific)
[AN-structured]: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[AN-eager]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
[AN-stop]: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
[AN-budget]: https://platform.claude.com/docs/en/build-with-claude/task-budgets
[AN-server-tools]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
[AN-websearch]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
[AN-code-exec]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
[AN-mcp]: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
[AN-cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[AN-tool-results]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
[AN-parallel]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
[AN-streaming]: https://platform.claude.com/docs/en/build-with-claude/streaming
[AN-vision]: https://platform.claude.com/docs/en/build-with-claude/vision
[AN-pdf]: https://platform.claude.com/docs/en/build-with-claude/pdf-support
[AN-files]: https://platform.claude.com/docs/en/build-with-claude/files
[AN-count]: https://platform.claude.com/docs/en/build-with-claude/token-counting
[AN-models]: https://platform.claude.com/docs/en/models/overview
[AN-sdk]: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript and https://github.com/anthropics/anthropic-sdk-typescript/blob/main/README.md
[AN-sdk-npm]: https://registry.npmjs.org/@anthropic-ai/sdk/latest (0.122.0) and https://bundlephobia.com/api/size?package=@anthropic-ai/sdk
[AN-sdk-scan]: npm tarball of `@anthropic-ai/sdk@0.122.0` grepped for `node:` imports (local scan)

OpenAI (platform.openai.com/docs 301-redirects to developers.openai.com/api/docs)
[OA-migrate]: https://developers.openai.com/api/docs/guides/migrate-to-responses
[OA-state]: https://developers.openai.com/api/docs/guides/conversation-state
[OA-functions]: https://developers.openai.com/api/docs/guides/function-calling
[OA-tools]: https://developers.openai.com/api/docs/guides/tools and https://developers.openai.com/api/docs/api-reference/responses/create
[OA-cache]: https://developers.openai.com/api/docs/guides/prompt-caching
[OA-images]: https://developers.openai.com/api/docs/guides/images-vision and https://developers.openai.com/api/docs/guides/pdf-files
[OA-chat]: https://developers.openai.com/api/docs/api-reference/chat/create
[OA-readme]: https://github.com/openai/openai-node/blob/master/README.md
[OA-npm]: https://registry.npmjs.org/openai/latest (7.8.0) and https://bundlephobia.com/api/size?package=openai
[OA-scan]: npm tarball of `openai@7.8.0` grepped for `node:` imports (local scan)

Google
[GG-functions]: https://ai.google.dev/gemini-api/docs/generate-content/function-calling
[GG-thinking]: https://ai.google.dev/gemini-api/docs/generate-content/thinking
[GG-cache]: https://ai.google.dev/gemini-api/docs/generate-content/caching
[GG-image-out]: https://ai.google.dev/gemini-api/docs/generate-content/image-generation
[GG-audio]: https://ai.google.dev/gemini-api/docs/audio , https://ai.google.dev/gemini-api/docs/video-understanding , https://ai.google.dev/gemini-api/docs/document-processing
[GG-interactions]: https://ai.google.dev/gemini-api/docs/interactions
[GG-openai]: https://ai.google.dev/gemini-api/docs/openai
[GG-readme]: https://github.com/googleapis/js-genai/blob/main/README.md
[GG-client]: https://raw.githubusercontent.com/googleapis/js-genai/main/src/client.ts
[GG-npm]: https://registry.npmjs.org/@google/genai/latest (2.19.0) and https://bundlephobia.com/api/size?package=@google/genai
[GG-scan]: npm tarball of `@google/genai@2.19.0` grepped for `node:` imports (local scan)

Internal
[RC]: docs/research/runtime-comparison.md (2026-08-28), sections 2 and 6
[HB]: docs/research/harness-baseline.md (2026-08-28), sections 2.3, 2.4 and 3
