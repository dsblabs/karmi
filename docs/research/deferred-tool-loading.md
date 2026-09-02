# Deferred tool loading and tool search

Research note, 2026-09-02, answering the question "how do Anthropic, the client SDKs, pi and Claude Code do deferred tool loading today, and what does that constrain for karmi?". Primary sources only: the Claude platform docs at `platform.claude.com` (fetched 2026-09-02 as `.md`), the `anthropics/anthropic-sdk-typescript` repository (`main`, commit `4140e0e`, 2026-09-01; 0.123.0), the `vercel/ai` repository (`main`, commit `7243530`, 2026-09-01; `@ai-sdk/anthropic` 4.0.48, `ai` 7.0.90), the `badlogic/pi-mono` repository (`main`, commit `96317e5`, 2026-09-02; `@mariozechner/pi-ai` and `pi-coding-agent` 0.84.4), the Claude Code docs at `code.claude.com` (fetched 2026-09-02), the OpenAI tool search guide at `developers.openai.com`, and the `openai/codex` repository (`main`, commit `a0dcfe2`, 2026-09-02). Every claim carries a bracket key from section 8; anything not verifiable from a primary source is marked UNVERIFIED.

## 1. Summary

1. **Anthropic tool search is GA, not beta.** The tool reference table lists "Beta header: None" for the tool search tool, the quick start uses the non-beta `client.messages.create`, the TypeScript SDK types it in the non-beta `messages` namespace, and the SDK's `AnthropicBeta` enum has no `advanced-tool-use-*` entry [AN-toolref] [AN-tst] [SDK-msgs] [SDK-beta].
2. **Two variants, one mechanism.** `tool_search_tool_regex_20251119` (Python `re.search()` patterns, max 200 chars) and `tool_search_tool_bm25_20251119` (natural-language query, max 500 chars) are "variants, not versions"; both take undated aliases (`tool_search_tool_regex`, `tool_search_tool_bm25`) [AN-tst] [AN-toolref]. Deferred tools carry `defer_loading: true`; the client still sends every full definition on every request; the API strips deferred definitions from the system-prompt prefix and re-injects them inline as `tool_reference` blocks where a search (or a client-supplied `tool_result` containing `tool_reference` blocks) surfaced them [AN-tst] [AN-cache].
3. **Persistence is by replay, not by session.** There is no server-side state: the client replays the assistant `server_tool_use` + `tool_search_tool_result` blocks and the same `tools` array, and "the API expands `tool_reference` blocks throughout the conversation history" on every request [AN-tst].
4. **Cost.** Tool search is not metered as a server tool; `usage.server_tool_use` has no tool-search field; loaded definitions count as ordinary input tokens [AN-tst]. Deferred tools cannot carry `cache_control` (400) and are excluded from the cache key [AN-tst] [AN-toolref].
5. **A second, newer mechanism exists in beta:** `mid-conversation-tool-changes-2026-07-01` adds `tool_addition` / `tool_removal` blocks inside a mid-conversation `role: "system"` message, letting the *client* decide when a `defer_loading: true` tool becomes visible without touching the prefix [AN-midconv] [SDK-beta-msgs].
6. **Client SDKs.** `@anthropic-ai/sdk` types every block on both namespaces; `BetaToolRunner` folds `tool_addition`/`tool_removal` into its active set [SDK-msgs] [SDK-runner]. `@ai-sdk/anthropic` exposes `anthropic.tools.toolSearchRegex_20251119()` / `toolSearchBm25_20251119()` as provider-executed tools, `providerOptions: { anthropic: { deferLoading: true } }` on any tool, a `tool-reference` custom tool-result part for client-side search, and `toolChanges` on mid-conversation system messages [AI-tools] [AI-prep] [AI-convert] [AI-opts].
7. **OpenAI has a native equivalent; Google does not.** OpenAI Responses (`gpt-5.4+`) has a `tool_search` tool, `defer_loading: true` on functions/namespaces/MCP servers, hosted or client-executed (`tool_search_call` / `tool_search_output`), and an `additional_tools` developer input item [OAI-ts]. The Gemini function-calling guide mentions nothing of the kind [GG-fc].
8. **pi implements the client-side pattern, not the server search tool.** `pi-ai` uses `ToolResultMessage.addedToolNames` as the load point, sends `defer_loading: true` plus a `tool_result` whose content is `tool_reference` blocks on Anthropic, and the `tool_search_call`/`tool_search_output`/`additional_tools` items on OpenAI Responses; the coding agent derives `addedToolNames` by diffing active tools before/after each tool call [PI-types] [PI-anth] [PI-oai] [PI-wrapper] [PI-docs].
9. **Claude Code does client-side tool search** with a built-in `ToolSearch` tool, on by default for MCP tools, governed by `ENABLE_TOOL_SEARCH` (`unset`/`true`/`auto`/`auto:N`/`false`, 10% context threshold in `auto`), disabled automatically behind non-first-party `ANTHROPIC_BASE_URL` because "most proxies don't forward `tool_reference` blocks" [CC-mcp] [CC-sdk-ts] [CC-tools] [CC-env].
10. **Codex CLI** has a client-side `tool_search` tool that runs BM25 over deferred tool metadata and marks tools `defer_loading` for the Responses API [CX-desc] [CX-handler] [CX-spec].

## 2. Anthropic tool search: current spec

### 2.1 Request shape

| Question | Finding | Source |
|---|---|---|
| Tool types | `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`; undated aliases `tool_search_tool_regex` / `tool_search_tool_bm25` resolve to the current version. "Variant, not version": neither supersedes the other. | [AN-tst] [AN-toolref] |
| Regex vs BM25 | Regex: Python `re.search()` patterns, case-insensitive, max 200 chars; picks by exact name fragments. BM25: natural-language query, max 500 chars; ranks by relevance. Both search "tool names, descriptions, argument names, and argument descriptions". | [AN-tst] |
| Search tool entry | `{ "type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex" }`; SDK type also allows `allowed_callers`, `cache_control`, `defer_loading`, `strict`. | [AN-tst] [SDK-msgs] |
| Deferring a tool | `"defer_loading": true` on the tool definition. SDK JSDoc: "If true, tool will not be included in initial system prompt. Only loaded when returned via tool_reference from tool search." Available on "All tools" per the reference table. | [AN-tst] [SDK-msgs] [AN-toolref] |
| Full definitions still sent | "You still send every tool's full definition in the `tools` array on every request, including the deferred ones. The API needs them server-side to run the search and expand `tool_reference` blocks." | [AN-tst] |
| Constraints | "At least one tool, normally the tool search tool itself, must stay non-deferred." "Never set `defer_loading: true` on the tool search tool itself." Guidance: keep the 3–5 most-used tools non-deferred. All-deferred returns 400 "At least one tool must have defer_loading=false. All tools cannot be deferred." | [AN-tst] |
| Beta header | None. Reference table: "Beta header: None". Quick start uses `client.messages.create`. SDK beta enum contains no advanced-tool-use entry. | [AN-toolref] [AN-tst] [SDK-beta] |
| Models | Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5. "Claude Opus 4.1 and earlier models don't support the tool search tool." | [AN-tst] |
| MCP connector | `mcp_toolset` entries take `defer_loading` in `default_config` (whole server) or per tool in `configs`. MCP connector itself is beta (`mcp-client-2025-11-20`) and not on Bedrock or Google Cloud. | [AN-tst] [AN-mcp] |
| Computer / browser toolsets | `defer_loading` per member via `configs`. Reference table: "Don't put `cache_control` on a toolset entry whose members defer". | [AN-tst] [AN-toolref] |
| Limits | Up to 10,000 deferred tools per request; search `limit` 1–10,000, default 5. | [AN-tst] |

### 2.2 What the model receives

"Initially, Claude's context contains only the tool search tool and any non-deferred tools." "Internally, the API excludes deferred tools from the system-prompt prefix." When a search returns references, "the API expands each `tool_reference` into the full definition" inline in the conversation, so the prefix is untouched [AN-tst] [AN-cache]. `input_examples` on a deferred tool are expanded together with the definition [AN-tst].

### 2.3 Response blocks and the client's obligations

| Block | Shape | Source |
|---|---|---|
| `server_tool_use` | `id: srvtoolu_...`, `name: tool_search_tool_regex` (or `_bm25`), `input: { pattern \| query, limit? }`. Streaming: `content_block_start` then `input_json_delta`. | [AN-tst] [SDK-msgs] |
| `tool_search_tool_result` | `tool_use_id`, `content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name }] }` or `{ type: "tool_search_tool_result_error", error_code }`. Empty match returns an empty `tool_references` array, not an error. | [AN-tst] [SDK-msgs] |
| Error codes | `invalid_tool_input`, `unavailable`, `too_many_requests`, `execution_time_exceeded` (HTTP 200). | [AN-tst] [SDK-msgs] |
| Client obligation | "Never return a `tool_result` for its `srvtoolu_...` ID." On the next request "pass the assistant's content back unchanged, including the `server_tool_use` and `tool_search_tool_result` blocks ... send the same `tools` array: the search tool plus every deferred definition." | [AN-tst] |
| Persistence | No server session. "The API expands `tool_reference` blocks throughout the conversation history, so Claude can reuse discovered tools in later turns without re-searching." Persistence therefore lasts as long as the client keeps the blocks in history (compaction that drops them drops the load). | [AN-tst] |

### 2.4 Custom (client-side) tool search

The client can replace the server search with its own tool: define an ordinary tool (e.g. embeddings search), and return a `tool_result` whose `content` is an array of `{ "type": "tool_reference", "tool_name": "..." }` blocks. Every referenced tool must be declared in `tools`, normally with `defer_loading: true`; an unknown name returns 400 "Tool reference 'unknown_tool' not found in available tools" [AN-tst]. The SDK's `ToolResultBlockParam.content` union includes `ToolReferenceBlockParam` (with optional `cache_control`) [SDK-msgs]. Anthropic publishes an embeddings-based cookbook for this [AN-cookbook]. pi's source notes an additional constraint observed in practice: "Anthropic rejects tool references mixed with ordinary tool-result content", so pi moves any real result text into sibling blocks after the `tool_result` [PI-anth]. UNVERIFIED against the docs, which show reference-only results.

### 2.5 Mid-conversation tool changes (beta)

A second mechanism, `mid-conversation-tool-changes-2026-07-01` (beta), lets the client add or remove tools between turns without a search: append a `role: "system"` message whose `content` contains `{ "type": "tool_addition" | "tool_removal", "tool": { "type": "tool_reference", "name": "..." } }` (or `mcp_tool_reference` / `mcp_toolset_reference` for MCP connector tools). "Every tool declared in `tools` is offered to the model from the start of the conversation unless it is declared with `defer_loading: true`, which keeps it withheld until a `tool_addition` block surfaces it." Referencing an undeclared name is a 400 [AN-midconv]. Placement: the system message cannot be first, must immediately follow a `user` turn (including one carrying `tool_result`s) or an assistant turn ending in a server tool result, must precede an assistant turn or end the array, and cannot sit between a `tool_use` and its `tool_result` [AN-midconv]. Models: Fable 5.1/5, Mythos 5.1/5, Opus 4.8, Opus 5; not Sonnet 5. Platforms: Claude API, Amazon Bedrock, Google Cloud [AN-midconv]. Note the field is `name` here versus `tool_name` in the tool-search `tool_reference` block [SDK-beta-msgs] [SDK-msgs].

### 2.6 Cost, caching, strict, tool_choice

| Question | Finding | Source |
|---|---|---|
| Metering | "Tool search isn't metered as a separate server tool. The response's `usage.server_tool_use` object has no tool search field, and the tool definitions that search loads into context count as input tokens like any other tool definition." | [AN-tst] |
| Cache key | "Tools with `defer_loading: true` are stripped from the rendered tools section before the cache key is computed." Deferred tools are "appended inline as a `tool_reference` block in the conversation history. The prefix is untouched." | [AN-toolref] [AN-cache] |
| `cache_control` on deferred | "A tool with `defer_loading: true` can't also carry `cache_control`: the API returns a 400." | [AN-tst] |
| Server results caching | Server tool results (incl. `tool_search_tool_result`) are auto-cached with 5-minute TTL when the request has at least one `cache_control`. | [AN-cache] |
| Editing `tools` | Modifying tool definitions invalidates the entire cache; changing `tool_choice` invalidates the messages cache. | [AN-cache] |
| Strict mode | "The grammar for strict mode ... builds from the full toolset, so `defer_loading` and strict mode compose without grammar recompilation." `strict` is available on all tools except `mcp_toolset` and the computer/browser toolsets. | [AN-tst] [AN-toolref] |
| `tool_choice` | Nothing in the tool-search, define-tools or tool-reference pages says whether `tool_choice: { type: "tool", name }` may target a deferred tool. UNVERIFIED. Related: toolsets reject `tool_choice` of type `tool`; Fable 5.1 / Mythos 5.1 reject `any`/`tool` with 400. | [AN-toolref] [AN-define] |
| Batch API | Supported. | [AN-tst] |

### 2.7 Platforms and gateways

| Platform | Finding | Source |
|---|---|---|
| Claude API | Supported, ZDR eligible. | [AN-overview] |
| Claude Platform on AWS | "server-side tool search works identically to the Claude API." | [AN-tst] |
| Amazon Bedrock | "available only through the InvokeModel API, not the Converse API." | [AN-tst] |
| Google Cloud (Vertex) | Listed as available in the features overview (`vertexAi`); the Google Cloud page's "not supported" list does not name tool search. | [AN-overview] [AN-vertex] |
| Microsoft Foundry | Listed as available (`azureAi`) in the features overview; Foundry page does not list it as unsupported. Claude Code docs state Foundry-on-Azure "rejects the server-side tool search" and falls back to loading tools upfront. UNVERIFIED which of the two statements applies to Azure-hosted deployments. | [AN-overview] [AN-foundry] [CC-mcp] |
| Cloudflare AI Gateway | The Anthropic provider page documents endpoint/header rewriting only; it says nothing about filtering request or response bodies. Whether `defer_loading`, `tool_reference` and `tool_search_tool_result` pass through unchanged is UNVERIFIED from docs (they are plain JSON body fields, so passthrough is the expected behaviour). Claude Code disables tool search for any non-first-party base URL because "most proxies don't forward `tool_reference` blocks". | [CF-anth] [CC-mcp] |

## 3. Client-side handling

### 3.1 `@anthropic-ai/sdk` (0.123.0)

| Item | Finding | Source |
|---|---|---|
| Namespace | Non-beta `src/resources/messages/messages.ts` declares everything: `Tool.defer_loading?: boolean`, `ToolSearchToolRegex20251119`, `ToolSearchToolBm25_20251119`, `ToolReferenceBlock { tool_name; type: 'tool_reference' }`, `ToolReferenceBlockParam` (+`cache_control`) as a member of `ToolResultBlockParam.content`, `ToolSearchToolResultBlock`, `ToolSearchToolSearchResultBlock`, `ToolSearchToolResultError`, `ToolSearchToolResultErrorCode`. `ContentBlock` includes `ToolSearchToolResultBlock`; `ServerToolUseBlock.name` includes `'tool_search_tool_regex' \| 'tool_search_tool_bm25'`. | [SDK-msgs] |
| Beta list | `AnthropicBeta` includes `mcp-client-2025-11-20` and `mid-conversation-tool-changes-2026-07-01`; no tool-search beta. | [SDK-beta] |
| Tool changes | `BetaRequestToolAdditionBlock` / `BetaRequestToolRemovalBlock` (`type: 'tool_addition' \| 'tool_removal'`, `tool: BetaToolChangeToolReference { name; type: 'tool_reference' } \| BetaToolChangeMCPToolReference \| BetaToolChangeMCPToolsetReference`). | [SDK-beta-msgs] |
| Tool runner | `BetaToolRunner` applies `tool_addition`/`tool_removal` from system messages to its active tool set (`applyToolReference`, `referencedToolName`). It does not implement a search tool or `addedToolNames`-style loading. | [SDK-runner] |
| Changelog | No "tool search" entry found in `CHANGELOG.md`. | [SDK-changelog] |

### 3.2 `@ai-sdk/anthropic` (4.0.48) and `ai` (7.0.90)

| Item | Finding | Source |
|---|---|---|
| Search tool | `anthropic.tools.toolSearchRegex_20251119()` / `toolSearchBm25_20251119()` built with `createProviderExecutedToolFactory`; input `{ pattern \| query, limit? }`; output schema `Array<{ type: 'tool_reference', toolName }>`. Provider tool ids `anthropic.tool_search_regex_20251119` / `anthropic.tool_search_bm25_20251119` map to wire types `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`. | [AI-tools] [AI-toolfile] [AI-prep] [AI-model] |
| Deferring | Per-tool `providerOptions: { anthropic: { deferLoading: true } }`; `prepareTools` emits `defer_loading` on the wire tool. JSDoc on the search tools: "Use `providerOptions: { anthropic: { deferLoading: true } }` on other tools to mark them for deferred loading." | [AI-prep] [AI-tools] |
| Round-trip | Tool-result parts for `tool_search_tool_regex`/`_bm25` are re-encoded as `tool_search_tool_result` + `tool_search_tool_search_result.tool_references` when the prompt is converted back. | [AI-convert] |
| Client-side search | A `custom` tool-result content part with `providerOptions.anthropic = { type: 'tool-reference', toolName }` converts to a `tool_reference` block inside a `tool_result`. | [AI-convert] |
| Tool changes | `providerOptions.anthropic.toolChanges: [{ type: 'tool_addition' \| 'tool_removal', toolName }]` on a mid-conversation system message; the beta header is added automatically. | [AI-opts] [AI-api] |
| Beta header | Changelog: "fix(anthropic): skip passing beta header for tool search tools" (i.e. none sent). | [AI-changelog] |
| Generic knobs | `activeTools: string[]` filters which of a typed tool set are sent on a call or per `prepareStep`; `toolOrder` stabilises ordering for caching; `dynamicTool` covers schemas unknown at compile time. None of these is deferred loading: `activeTools` changes the `tools` array itself. | [AI-docs-tools] |

### 3.3 OpenAI and Google

OpenAI Responses API: "Only gpt-5.4 and later models support `tool_search`." Add `{ type: "tool_search" }` to `tools`, mark functions (or MCP server tool definitions, or namespaces) with `defer_loading: true`. Hosted mode: OpenAI searches and returns `tool_search_call` + `tool_search_output` (`execution: "server"`) in the same response. Client-executed mode: model emits `tool_search_call`, the app performs the lookup and returns a `tool_search_output` (`execution: "client"`). An `additional_tools` input item with `role: "developer"` makes tools available "at a specific point in the conversation". Discovered tools "are injected at the end of the context window" to preserve the cache [OAI-ts]. Google: the Gemini function-calling guide contains no deferred-loading or tool-search concept [GG-fc].

## 4. pi (badlogic/pi-mono)

pi does implement deferred loading, as a provider-neutral "load point" abstraction rather than the Anthropic server search tool.

| File | What it does | Source |
|---|---|---|
| `packages/ai/src/types.ts` | `ToolResultMessage.addedToolNames?: string[]`: "Names from `Context.tools` that became available after this result. Providers with native deferred tool loading use this as the load point; other providers ignore it and use `Context.tools` normally." Compat flags: `AnthropicMessagesCompat.supportsToolReferences` ("Default: true for first-party Anthropic models except Haiku and models older than Claude 4.5"), `OpenAIResponsesCompat.supportsToolSearch` / `supportsAdditionalTools`, `OpenAICompletionsCompat.deferredToolsMode: "kimi"`. | [PI-types] |
| `packages/ai/src/utils/deferred-tools.ts` | `splitDeferredTools(context, enabled, normalizeName)`: any tool named in some `addedToolNames` that the assistant never called becomes `deferred`; everything else `immediate`. | [PI-split] |
| `packages/ai/src/api/anthropic-messages.ts` | Sends `defer_loading: true` for deferred tools (never with `cache_control`); if nothing is immediate, sends all as immediate to avoid the all-deferred 400; encodes each load point as `tool_result.content = [{ type: "tool_reference", tool_name }]` and moves the real result text to sibling blocks after all `tool_result`s. Does not add the server `tool_search_tool_*` tool. | [PI-anth] |
| `packages/ai/src/api/openai-responses-shared.ts` | Either `{ type: "additional_tools", role: "developer", tools }` or a synthetic `tool_search_call` / `tool_search_output` pair (`execution: "client"`) with `defer_loading: true` on deferred functions. | [PI-oai] |
| `packages/ai/scripts/generate-models.ts` | `OPENAI_TOOL_SEARCH_MODEL_IDS` (gpt-5.4, gpt-5.4-mini/-pro, gpt-5.5, gpt-5.6-*) get `supportsToolSearch`. | [PI-models] |
| `packages/coding-agent/src/core/extensions/wrapper.ts` | After a tool executes, diffs `runner.getActiveTools()` before/after; if the change is purely additive, sets `result.addedToolNames`. | [PI-wrapper] |
| `packages/coding-agent/docs/extensions.md` "Dynamic Tool Loading" | Register all tools, keep a loader tool (e.g. `search_tools`) active, call `pi.setActiveTools([...current, ...matching])` additively. Anthropic native path = `defer_loading` + `tool_reference`; OpenAI native (gpt-5.4+) = client `tool_search_call`/`tool_search_output`; otherwise fallback = full active tool list resent (may invalidate cache); non-additive changes always use the fallback. | [PI-docs] |
| `packages/coding-agent/examples/extensions/kimi-deferred-tools.ts`, `packages/ai/test/deferred-tools.test.ts` | Example and tests. | [PI-example] [PI-test] |

## 5. Claude Code

| Question | Finding | Source |
|---|---|---|
| Mechanism | Client-side. Built-in `ToolSearch` tool "Searches for and loads deferred tools when tool search is enabled"; "Permission required: No". `WaitForMcpServers` exists only when tool search is disabled. | [CC-tools] |
| What loads at start | "Only tool names and server instructions load at session start"; full schemas load on demand. Tool descriptions and server instructions are truncated at 2KB. | [CC-mcp] |
| Default | "Tool search is enabled by default" for MCP tools; requires Sonnet 4.5 / Haiku 4.5 / Opus 4.5 or later. Disabled automatically when `ANTHROPIC_BASE_URL` points at a non-first-party host "since most proxies don't forward `tool_reference` blocks", on Agent Platform with pre-4.5 models, and on Foundry-on-Azure. | [CC-mcp] |
| `ENABLE_TOOL_SEARCH` | unset = defer all MCP tools (with the fallbacks above); `true` = always defer and send the tool-search beta header even through proxies; `auto` = load deferrable tools upfront "while their definitions total less than 10% of the context window, and defers all of them once the definitions reach 10%"; `auto:N` = custom percentage; `false` = load everything upfront. | [CC-mcp] [CC-env] |
| What counts toward the threshold | Deferrable definitions: MCP tools not marked `alwaysLoad` plus on-demand built-ins; core Bash/Read/Edit are always loaded and not counted. | [CC-sdk-ts] |
| Pinning | `alwaysLoad: true` per server in `.mcp.json`; `"anthropic/alwaysLoad": true` in a tool's `_meta`. | [CC-mcp] |
| How many load, how long | "Up to five of the most relevant tools are loaded into context by default, where they stay available for subsequent turns until the SDK compacts the messages where the agent discovered them. After that compaction, the agent searches for those tools again." | [CC-sdk-ts] |
| Permissions after load | Loaded tools are subject to normal permission rules (e.g. `allowedTools: ["mcp__enterprise-tools__*"]`). `ToolSearch` itself can be denied via `"permissions": { "deny": ["ToolSearch"] }`. | [CC-sdk-ts] [CC-mcp] |
| Betas / proxies | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` strips beta headers and fields "such as `defer_loading` and `eager_input_streaming`" (managed settings can re-enable, v2.1.227+). Gateway protocol page: with the managed override Claude Code "keeps sending the tool-search beta header, `defer_loading` tool fields, and `tool_reference` blocks". The header string is not named in the docs; the API docs say none is required. UNVERIFIED what header Claude Code actually sends. | [CC-env] [CC-gateway] [AN-toolref] |
| Observed behaviour | In this session the system prompt says: "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them", followed by a name list. `ToolSearch` accepts `select:A,B` or keyword queries with `max_results`; a load returns the full `<functions>` JSON-schema block inline in the tool result. | [CC-observed] |
| Failed servers | Reported inside `ToolSearch` results rather than at startup. | [CC-mcp] |

## 6. Client-side emulation: what a "tool index + load_tool" pattern needs

Prior art (Claude Code, pi, Codex) converges on the same shape:

1. **An index the model can see cheaply.** Names (and optionally one-line descriptions) of deferred tools in the prompt, plus one always-loaded loader tool. Claude Code lists names in the system prompt and offers `ToolSearch` [CC-observed]; pi keeps `search_tools` active and lists nothing by default [PI-docs]; Codex renders app descriptions into the `tool_search` description and runs BM25 over deferred metadata client-side [CX-desc] [CX-handler].
2. **A load point that is additive and stable across turns.** pi records it on the tool result (`addedToolNames`) [PI-types]; Codex persists `defer_loading` state per thread (`0019_thread_dynamic_tools_defer_loading.sql`) [CX-migration]; Claude Code re-searches after compaction drops the discovery messages [CC-sdk-ts].
3. **A provider-specific encoding of the load point.** Anthropic: `defer_loading` + `tool_reference` blocks in a `tool_result` (no beta), or `tool_addition` in a system message (beta) [AN-tst] [AN-midconv]. OpenAI Responses (gpt-5.4+): `tool_search_call`/`tool_search_output` or `additional_tools` [OAI-ts]. Anything else: resend the enlarged `tools` array and accept the cache invalidation [PI-docs] [AI-docs-tools].
4. **A fallback for providers with no native support.** pi's `splitDeferredTools` collapses to "all immediate" when the compat flag is off [PI-split]; the Vercel AI SDK offers only `activeTools`, which rewrites `tools` [AI-docs-tools].
5. **Validation before the call.** Claude Code rejects calls to unloaded tools with `InputValidationError` [CC-observed]; Anthropic rejects references to undeclared names with 400 [AN-tst].

## 7. Implications for karmi

Constraints the design must respect (not a design):

- **No beta gate on Anthropic.** `defer_loading` + `tool_reference` works on the plain Messages endpoint with `@anthropic-ai/sdk` 0.123.0 types, for Claude 4.5+ (not Haiku for client-side references per pi's compat note; UNVERIFIED from Anthropic docs) [AN-toolref] [SDK-msgs] [PI-anth].
- **Every deferred definition must be in every request.** Deferring saves prompt tokens, not request bytes; karmi must keep the full tool set materialised per turn [AN-tst].
- **At least one tool must be non-deferred; deferred tools cannot carry `cache_control`; the server search tool must not be deferred** [AN-tst].
- **Loaded state lives in the transcript.** Whatever karmi persists between turns (or drops on compaction) determines which tools stay loaded; Claude Code accepts re-searching after compaction [AN-tst] [CC-sdk-ts].
- **Two Anthropic mechanisms with different placement rules.** `tool_reference` rides in a `tool_result`; `tool_addition` needs a mid-conversation `system` message with strict placement, a beta header, and a narrower model list (no Sonnet 5) [AN-tst] [AN-midconv].
- **Proxies/gateways are the main deployment risk.** Claude Code turns the feature off behind any non-first-party base URL; Cloudflare AI Gateway passthrough of these body fields is UNVERIFIED. If karmi routes through a gateway it needs a probe or a switch equivalent to `ENABLE_TOOL_SEARCH` [CC-mcp] [CF-anth].
- **Platform variance.** Bedrock only via InvokeModel; MCP connector `defer_loading` is unavailable on Bedrock and Google Cloud; Foundry-on-Azure status is ambiguous between the two doc sets [AN-tst] [AN-mcp] [CC-mcp] [AN-overview].
- **Cost model is plain input tokens.** No separate line item; the win is entirely prefix size and cache hit rate, so any measurement should compare `input_tokens` / cache-read tokens with and without deferral [AN-tst] [AN-cache].
- **Provider seam.** Native support exists for Anthropic and OpenAI Responses (gpt-5.4+) with different wire shapes; any other provider needs an `activeTools`-style fallback that rewrites `tools` and invalidates the cache. pi's `addedToolNames` is the smallest provider-neutral abstraction found [PI-types] [OAI-ts] [AI-docs-tools].
- **If karmi consumes MCP tools through Claude Code / Agent SDK semantics,** `alwaysLoad`, `_meta["anthropic/alwaysLoad"]`, the 10% `auto` threshold, 2KB description truncation, and "up to five tools per search" are the established defaults developers already know [CC-mcp] [CC-sdk-ts].
- **Open questions:** `tool_choice` targeting a deferred tool; the exact header Claude Code sends; whether mixed `tool_reference` + text content in one `tool_result` is rejected [AN-define] [CC-gateway] [PI-anth].

## 8. Sources

- [AN-tst] https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- [AN-toolref] https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- [AN-cache] https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- [AN-define] https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- [AN-mcp] https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- [AN-midconv] https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- [AN-overview] https://platform.claude.com/docs/en/build-with-claude/overview
- [AN-vertex] https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
- [AN-foundry] https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry
- [AN-cookbook] https://platform.claude.com/cookbook/tool-use-tool-search-with-embeddings
- [SDK-msgs] https://github.com/anthropics/anthropic-sdk-typescript/blob/4140e0e/src/resources/messages/messages.ts
- [SDK-beta] https://github.com/anthropics/anthropic-sdk-typescript/blob/4140e0e/src/resources/beta/beta.ts
- [SDK-beta-msgs] https://github.com/anthropics/anthropic-sdk-typescript/blob/4140e0e/src/resources/beta/messages/messages.ts
- [SDK-runner] https://github.com/anthropics/anthropic-sdk-typescript/blob/4140e0e/src/lib/tools/BetaToolRunner.ts
- [SDK-changelog] https://github.com/anthropics/anthropic-sdk-typescript/blob/4140e0e/CHANGELOG.md
- [AI-toolfile] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/tool/tool-search-regex_20251119.ts (and `tool-search-bm25_20251119.ts`)
- [AI-tools] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/anthropic-tools.ts
- [AI-prep] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/anthropic-prepare-tools.ts
- [AI-convert] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/convert-to-anthropic-prompt.ts
- [AI-opts] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/anthropic-language-model-options.ts
- [AI-api] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/anthropic-api.ts
- [AI-model] https://github.com/vercel/ai/blob/7243530/packages/anthropic/src/anthropic-language-model.ts
- [AI-changelog] https://github.com/vercel/ai/blob/7243530/packages/anthropic/CHANGELOG.md
- [AI-docs-tools] https://github.com/vercel/ai/blob/7243530/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx
- [OAI-ts] https://developers.openai.com/api/docs/guides/tools-tool-search
- [GG-fc] https://ai.google.dev/gemini-api/docs/function-calling
- [PI-types] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/src/types.ts
- [PI-split] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/src/utils/deferred-tools.ts
- [PI-anth] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/src/api/anthropic-messages.ts
- [PI-oai] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/src/api/openai-responses-shared.ts
- [PI-models] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/scripts/generate-models.ts
- [PI-wrapper] https://github.com/badlogic/pi-mono/blob/96317e5/packages/coding-agent/src/core/extensions/wrapper.ts
- [PI-docs] https://github.com/badlogic/pi-mono/blob/96317e5/packages/coding-agent/docs/extensions.md
- [PI-example] https://github.com/badlogic/pi-mono/blob/96317e5/packages/coding-agent/examples/extensions/kimi-deferred-tools.ts
- [PI-test] https://github.com/badlogic/pi-mono/blob/96317e5/packages/ai/test/deferred-tools.test.ts
- [CC-mcp] https://code.claude.com/docs/en/mcp (section "Scale with MCP tool search")
- [CC-sdk-ts] https://code.claude.com/docs/en/agent-sdk/tool-search
- [CC-tools] https://code.claude.com/docs/en/tools
- [CC-env] https://code.claude.com/docs/en/env-vars
- [CC-gateway] https://code.claude.com/docs/en/llm-gateway-protocol
- [CC-observed] Claude Code 2.1.251 session on 2026-09-02 (system prompt text and `ToolSearch` results observed directly)
- [CX-desc] https://github.com/openai/codex/blob/a0dcfe2/codex-rs/core/templates/search_tool/tool_description.md
- [CX-handler] https://github.com/openai/codex/blob/a0dcfe2/codex-rs/core/src/tools/handlers/tool_search.rs
- [CX-spec] https://github.com/openai/codex/blob/a0dcfe2/codex-rs/tools/src/tool_search.rs
- [CX-migration] https://github.com/openai/codex/blob/a0dcfe2/codex-rs/state/migrations/0019_thread_dynamic_tools_defer_loading.sql
- [CF-anth] https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
