# Cloudflare Agents SDK: build on it, beside it, or ignore it?

Research note, 2026-08-29, answering GitHub issue #5. Primary sources only: the `cloudflare/agents` repository on `main` (source under `packages/agents/src`, `packages/ai-chat`, `packages/think`, `design/*.md`, `CHANGELOG.md`, `AGENTS.md`, `package.json`), the npm registry (`agents`, `@cloudflare/ai-chat`, `@cloudflare/think`), and developers.cloudflare.com/agents. Source was read from raw.githubusercontent.com at commit state of 2026-08-29 (repo `pushed_at` 2026-08-29T00:06Z); line numbers below refer to that snapshot and will drift. Every claim carries a bracket key from section 8; anything not verifiable from a primary source is marked UNVERIFIED. Glossary (Framework, Harness, Primitive, Capability, Channel, Scope) follows `CONTEXT.md`; prior decisions are cited as [RC] (runtime comparison), [HB] (harness baseline) and [PS] (provider seam).

Date-sensitive: `agents` is 0.22.0 (2026-08-27) and still pre-1.0 [Agents-npm]; 0.22.0 vendored PartyServer into `agents/lifecycle`, made hibernation mandatory, moved schedules into a Lifecycle-owned job queue and made chat recovery unconditional [Agents-changelog]; `AIChatAgent` moved out of `agents` into `@cloudflare/ai-chat` (the old `agents/ai-chat-agent` entry now throws) [Agents-aichat-stub]; the `agents` CLI binary was removed [Agents-changelog]; the docs site still documents `static options = { hibernate: false }` which 0.22.0 removed [Agents-ws][Agents-changelog].

## 1. Summary and recommendation

**Recommendation: build BESIDE. Confirm the side remark in [RC §3]: read it, borrow patterns and a few MIT-licensed pieces, but do not extend `Agent`, do not persist its types, and do not take `agents` as a runtime dependency in v0.** Re-evaluate at `agents` 1.0 or when `agents/lifecycle` drops its `@experimental` marker, because the 0.22.0 refactor is heading towards exactly the composable shape karmi would want to build on (section 6).

Why not ON:

1. **It dictates the persistence layer, not just the transport.** `Agent`'s constructor runs `_ensureSchema()` on every wake and creates `cf_agents_state`, `cf_agents_queues`, `cf_agents_workflows`, `cf_agents_runs`, `cf_agents_facet_runs`, `cf_agents_fibers`, `cf_agent_tool_runs` plus a schema-version row; it also constructs an `MCPClientManager`, installs three Lifecycle capabilities, auto-wraps every user method with context/tracing, and computes hook-dispatch modes [Agents-ctor]. The chat layer persists **AI SDK `UIMessage`** rows (`cf_ai_chat_agent_messages`) and replays them through `ResumableStream` [AIChat-src]. That is the opposite of [PS §1] decision 1 (karmi owns a plain-JSON `Message`/`ProviderEvent` schema that does not change when a dependency bumps a major); the AI SDK went 4→5→6→7 in 19 months [PS §2.1] and `@cloudflare/ai-chat` tracks it with a migration shim (`ai-chat-v5-migration.ts`) [AIChat-pkg].
2. **Its state model is a single JSON blob broadcast whole to every socket** (`setState` → `INSERT OR REPLACE INTO cf_agents_state` → `broadcast(CF_AGENT_STATE)` → `onStateChanged`; clients may push state back) [Agents-state][Agents-state-src]. karmi's Harness needs a monotonic event stream with replay from an id [HB §3], which the SDK has only inside the chat layer (`ResumableStream`, AI SDK chunk shaped).
3. **Its addressing is class-per-binding, name-per-instance** (`/agents/:kebab-class/:name`, `routeAgentRequest` scans `env` for anything with `idFromName`) [Agents-routing-src]. There is no Scope: per-tenant config arrives only as `props` in a base64 header on the first request [Agents-routing-src]. Workers for Platforms is not mentioned anywhere in `packages/agents/src` (grep) [Agents-src-grep].
4. **Stability.** 22 minor versions in the twelve months since 0.1.0 (2025-09-10), 9–18 releases per month in Feb–Jun 2026, and "Compatibility notes" that rename or remove public surface inside minors (`onStateUpdate`→`onStateChanged`, `unstable_callable`→`callable`, `MCPClientManagerOptions.storage` removed, `hibernate` option removed, `createAISDKTelemetry` removed) [Agents-npm-time][Agents-changelog]. `subAgent()`, `agents/lifecycle`, Sessions, Think, `agents/browser` are all marked `@experimental` in source [Agents-subagent-src][Agents-lifecycle-index][Sessions][Think-readme]. No semver or support-window statement exists on the docs site (the limits page carries none) [Agents-limits].
5. **Weight on the hot path.** `agents` unpacks to 5.28 MB / 232 files [Agents-npm]; `src/index.ts` alone is 422 KB (~12,000 lines) [Agents-tree]; runtime `dependencies` include `esbuild`, `@babel/plugin-proposal-decorators` and `@rolldown/plugin-babel` (for the Vite plugin, but installed for everyone) [Agents-pkg]; `@modelcontextprotocol/client 2.0.0`, `/server 2.0.0` and `/sdk 1.30.0` are **exact-pinned, non-optional peers** [Agents-pkg]; `node:async_hooks` and `node:diagnostics_channel` force `nodejs_compat` [Agents-src-grep]; `@callable()` needs TC39 decorators, i.e. the `agents/vite` plugin or a bundler configured for `2023-11` decorators [Agents-readme].

Why not IGNORE:

- It is the only public, production-scale reference for the exact problems karmi has on Cloudflare: one alarm multiplexed across schedules, keep-alive heartbeats and fiber recovery [Agents-scheduler-src][Agents-lifecycle-upstream]; hibernation-safe connection state [Agents-ws]; OAuth for remote MCP inside a DO with PKCE state in `ctx.storage` [Agents-oauth-src]; SSRF guard for MCP URLs [Agents-mcp-client-src]; DO facets for colocated sub-agents with a root-owned alarm [Agents-rfc-subagents][DO-facets]; Workflow→Agent callbacks resolved by name [Agents-workflow-src]; signed reply-to email headers [Agents-email-src]; test harness under `@cloudflare/vitest-pool-workers` with a `wrangler.jsonc` per suite [Agents-vitest]. Every one of these is a design karmi must reproduce.

Middle path examined and mostly rejected for v0: depending on `agents/mcp/client` alone. Since 0.22.0 `MCPClientManager` is a `LifecycleCapability` that receives storage from the `Lifecycle` it is installed on; "standalone construction with an explicit `DurableObjectStorage` is no longer supported" [Agents-changelog]. Using it means installing `agents/lifecycle` (experimental) in karmi's DO, which is "build ON" by another name. What is worth **vendoring** (MIT, with attribution in a `THIRD_PARTY_LICENSES` file as the SDK itself does for PartyServer [Agents-lifecycle-upstream]) is listed in section 7.

What would change this recommendation: (a) `agents` 1.0 with a stated support window and `agents/lifecycle` + `agents/schedules` + `agents/mcp/client` stabilised as standalone capabilities — karmi's session DO could then compose `Lifecycle.install(this)` and keep its own Harness, persistence and provider seam above it; (b) Cloudflare making the chat wire protocol (`agents/chat/transport`) AI-SDK-independent, which would make `useAgentChat` a cheap Channel adapter; (c) a decision that karmi's v0 Channel is only the AI SDK React UI, in which case `@cloudflare/ai-chat`'s resumable-stream work is worth more than the coupling costs.

## 2. Inventory: what the SDK provides

| Area | What it is (with source) | Status markers |
|---|---|---|
| **Agent base class** | `export class Agent<Env, State, Props> extends DurableObject<Env>` (`index.ts:1531`). Hooks: `onStart(props?)`, `onRequest`, `onConnect(conn, ctx)`, `onMessage`, `onClose`, `onError` (overloaded with/without connection), `onEmail`, `onStateChanged(state, source)` (`onStateUpdate` deprecated), `validateStateChange`, `getConnectionTags`, `shouldSendProtocolMessages`, `onAlarm`, `onJob`, `onFiberRecovered`, `onWorkflowProgress/Complete/Error` [Agents-class][Agents-ctor]. Static options: `sendIdentityOnConnect`, `hungScheduleTimeoutSeconds`, `keepAliveIntervalMs` (30 s), `retry`, fiber/agent-tool/detached budgets, `maxAlarmMemoryLimitStrikes` [Agents-options-src]. `destroy()` drops tables, alarms, storage [Agents-class]. | Core hooks stable; `this.lifecycle`, `this.scheduler` experimental [Agents-changelog] |
| **DO lifecycle substrate** | `agents/lifecycle`: PartyServer 0.5.10 vendored (ISC), `Lifecycle.install(this)` installs fetch/alarm/hibernating-WS entry points on any `DurableObject`; Lifecycle "owns the physical Durable Object alarm", capabilities contribute wake times; hibernation mandatory; `ctx.id.name` authoritative [Agents-lifecycle-upstream][Agents-lifecycle-index]. `LifecycleCapability` gets `storage`, `sockets` (accept/get by tag), `ready`, `jobs` (queue), `events.emit`, `routes` (to root / to another Lifecycle) [Agents-capability-src]. | `@experimental Every export here may change` [Agents-lifecycle-index] |
| **SQL and state** | `this.sql<T>` tagged template over `ctx.storage.sql`; returns arrays [Agents-state]. `this.state` lazy-loads the `cf_agents_state` row (id `cf_state_row_id`), `initialState` applied on first access; `setState` = persist + broadcast `MessageType.CF_AGENT_STATE` (excluding connections that opted out) + `onStateChanged` (best-effort); clients can push a `cf_agent_state` frame, gated by `validateStateChange` [Agents-state][Agents-state-src]. State must be JSON-serialisable [Agents-state]. Docs limits page says 1 GB state per Agent (DO SQLite allows 10 GB [RC §2]; discrepancy unexplained) [Agents-limits]. | Stable |
| **Scheduling** | `schedule(when: Date\|string\|number, callback: keyof this, payload?, {retry?, idempotent?})`, `scheduleEvery`, `getScheduleById`, `listSchedules(criteria)`, `cancelSchedule`; types `scheduled\|delayed\|cron\|interval`; cron via `cron-schedule` at minute granularity; ≤2 MB per task [Agents-sched]. Since 0.22.0 schedules are rows in the Lifecycle job queue (schema v2); `Scheduler` "owns no storage of its own"; default retry `maxAttempts 3, baseDelayMs 100, maxDelayMs 3000`; one-shot dedup only with `idempotent: true`, recurring dedup by default [Agents-scheduler-src]. Callback is a **method name string** resolved on the Agent at dispatch [Agents-ctor]. `keepAlive()` arms a heartbeat on the same alarm [Agents-durable]. Also `queue(callback, payload)` in `cf_agents_queues` [Agents-class]. | `agents/schedules` standalone: experimental; `this.schedule*`: "the stable surface" [Agents-changelog][Agents-src-grep] |
| **HTTP / WS routing** | `routeAgentRequest(request, env, {prefix="agents", jurisdiction, locationHint, props, cors, onBeforeConnect, onBeforeRequest})`; URL `/{prefix}/{kebab-class}/{name}[/sub/{class}/{name}...]/{rest}`; it enumerates `env` for objects with `idFromName` and maps kebab→binding; `props` travel in header `x-agents-lifecycle-props` (base64 JSON) [Agents-routing-src][Agents-routing]. `getAgentByName(ns, name, {props, jurisdiction, locationHint, routingRetry})` for Worker-side RPC [Agents-routing]. `hono-agents` 3.0.12 wraps it for Hono [Hono-pkg]. Identity frame sent on connect unless `sendIdentityOnConnect: false` [Agents-routing]. | Stable |
| **WebSockets** | Hibernation API only; `Connection.setState` persisted in the socket attachment; `broadcast(msg, exclude[])`; tags via `getConnectionTags`; readonly connections; `shouldSendProtocolMessages` for binary clients [Agents-ws][Agents-changelog]. Protocol frames: `cf_agent_state`, `rpc`, identity, MCP server list [Agents-protocol-src]. | Stable |
| **Callable / RPC** | `@callable({description?, streaming?})` method decorator (WeakMap registry); client sends `{type:"rpc", id, method, args}`, gets `{type, id, success, result, done?}`; streaming through `StreamingResponse`; a Cap'n Web (`capnweb`) callables endpoint exists as a second interface in the WebSockets capability [Agents-callable-src][Agents-src-grep]. Client: `agents/client` `AgentClient` over `partysocket` (typed `agent.stub.method()`, 30 s call timeout), `agents/react` `useAgent({agent, name, basePath, onStateUpdate, onIdentity})` [Agents-client-src][Agents-readme]. | Stable; needs decorator transform [Agents-readme] |
| **Sub-agents** | `subAgent(cls, name)`, `abortSubAgent`, `deleteSubAgent`; children are **DO facets** (`ctx.facets.get`, class looked up in `ctx.exports`): colocated on the same machine, own SQLite, root DO owns the alarm and hibernatable sockets and forwards frames to children; typed `SubAgentStub<T>` hides `Agent` internals; external address `/sub/{class}/{name}`; `buildAgentPath()` [Agents-subagent-src][Agents-subrouting-src][Agents-rfc-subagents]. Facets are documented under Dynamic Workers ("each facet has its own SQLite database, separate from the supervisor's") [DO-facets]. | `@experimental` [Agents-subagent-src] |
| **Durable execution** | `runFiber(name, fn)` / `startFiber` (accepted-before-run, idempotency key) / `stash(data)` (sync checkpoint, replaces previous) / `onFiberRecovered(ctx)`; rows in `cf_agents_fibers`; no automatic retry; eviction triggers listed as inactivity 70–140 s, code updates "1–2× daily", 15-min alarm cap [Agents-durable][Agents-src-grep]. `runWorkflow(binding, params, {retention, agentBinding})` tracked in `cf_agents_workflows`; `AgentWorkflow extends WorkflowEntrypoint` with `this.agent` typed RPC, `reportProgress`, `broadcastToClients`, `waitForApproval`; callbacks re-resolve the Agent **by name** and by `constructor.name` (bundler must keep class names) [Agents-workflow-src]. | Fibers documented without beta marker [Agents-durable] |
| **AI chat** | `@cloudflare/ai-chat` 0.11.0: `AIChatAgent extends Agent`; `onChatMessage(onFinish, {abortSignal, body, continuation, requestId}) → Response`; `this.messages: UIMessage[]`; `saveMessages` / `persistMessages`; `maxPersistedMessages`; `createUIMessageStream` + `streamText`; resumable streams buffered in SQLite; row compaction at ~1.8 MB; every turn runs in a recovery fiber (0.22.0); `useAgentChat({agent, onToolCall, resume})`; tools via AI SDK `tool()` with `needsApproval` [AIChat-docs][AIChat-src][Agents-changelog]. Peers: `ai ^6 \|\| ^7`, `@ai-sdk/react ^3 \|\| ^4`, `react ^19` [AIChat-pkg]. `agents/agent-tools` (`agentTool`, `runAgentTool`) imports from `ai` [Agents-src-grep]. `agents/chat` is the shared toolkit (turn queue, resumable stream, sanitize, tool state, recovery engine, `ws-chat-transport`) used by both `@cloudflare/ai-chat` and Think [Agents-AGENTSmd]. | 0.x; AI SDK-shaped persistence |
| **Think (harness)** | `@cloudflare/think` 0.17.0: "opinionated chat agent base class" with agentic loop, `getModel()/getSystemPrompt()/getTools()`, `runTurn()`, Sessions, extensions, messengers (Telegram via `chat` SDK), workspace/shell/code-mode tools, agent-tool dispatch; deps `@ai-sdk/anthropic ^4`, `@ai-sdk/openai ^4`, `workers-ai-provider ^4`, `@cloudflare/codemode`, `@cloudflare/shell`, `just-bash` [Think-pkg][Think-readme][Think-docs]. | "Experimental — the API surface is stable but may evolve" [Think-readme] |
| **Sessions / memory** | `agents/experimental/memory/session`: `Session.create(this)` builder; tree messages (`parent_id`) in `assistant_messages`; context blocks with four provider types; FTS5 search; non-destructive compaction overlays in `assistant_compactions` (`createCompactFunction({summarize, protectHead: 3, tailTokenBudget: 20000, minTailMessages: 2})`, auto between turns); `SessionManager` for many sessions per DO with fork/`compactAndSplit`; Postgres providers via Hyperdrive [Sessions]. | Experimental [Sessions] |
| **MCP client** | `MCPClientManager extends LifecycleCapability` (`mcp/client/index.ts:390`); `this.addMcpServer(name, urlOrDOBinding, {id, transport:{type: auto\|streamable-http\|sse\|rpc, headers, authProvider}, props, callbackUrl})`; persisted in `cf_agents_mcp_servers`; auto transport tries streamable-http then SSE; DO-to-DO "rpc" transport; `DurableObjectOAuthClientProvider` stores client info, tokens, PKCE verifier and state nonce under `ctx.storage` keys and intercepts the callback route; elicitation handlers; x402 payments; SSRF guard blocks RFC 1918/link-local/metadata; `listTools/callTool/getAITools()` where `MCPAITool` is a **structural** `{description, execute, inputSchema: z.ZodType}` "compatible with the AI SDK without importing its types" [Agents-mcp-client-src][Agents-mcp-conn-src][Agents-oauth-src][Agents-mcp]. Depends on `@modelcontextprotocol/client 2.0.0` (exact) [Agents-pkg]. | Agent-facing API stable; standalone capability experimental [Agents-changelog] |
| **MCP server** | `agents/mcp/server` `createMcpHandler` = stateless SDK-v2 Worker wrapper + `getMcpAuthContext` [Agents-mcp-server-index]; `McpAgent` (SDK v1, one DO per `mcp-session-id`, SSE and Streamable HTTP transports, `props` persisted in storage) is `@deprecated McpAgent is feature-frozen` [Agents-mcp-legacy-src][Agents-mcp-utils-src]. | v2 path new; v1 frozen |
| **Email** | `agents/email`: `routeAgentEmail(email, env, {resolver})` with `createAddressBasedEmailResolver`, `createCatchAllEmailResolver`, `createSecureReplyEmailResolver` (HMAC-signed headers, 30-day max age), `isAutoReplyEmail`; Agent `onEmail`, `replyToEmail`; `EmailBridge extends RpcTarget` [Agents-email-src]. | Stable |
| **Observability** | `this.observability.emit(event)` → `node:diagnostics_channel` channels `agents:state|rpc|message|chat|transcript|fiber|agent_tool|schedule|lifecycle|workflow|mcp|email`; Tail Worker consumption; override or set `observability = undefined` [Agents-obs-src][Agents-diag]. Tracing: Workers traces with GenAI semconv spans `invoke_agent`, `chat`, `execute_tool`, `tool_approval`; `wrapAISDK(ai)` instruments AI SDK v6/v7; internal spans `agent_initialization`, `initialize_agent_storage` [Agents-tracing][Agents-ctor]. | Stable |
| **Skills, code mode, browser, sandbox** | `agents/skills` (SKILL.md registry, R2 source, experimental runner); `@cloudflare/codemode` 0.5.1 (LLM writes code that calls tools); `agents/browser` (CDP, experimental); Sandbox docs show `getSandbox(env.Sandbox, this.name)` with `writeFile/exec` and advise pairing with fibers/Workflows [Agents-AGENTSmd][Codemode-pkg][Agents-sandbox]. | Mostly experimental |
| **Testing** | Every suite is `@cloudflare/vitest-pool-workers` + `agents/vite` plugin + a `wrangler.jsonc` declaring each DO class, `retry: 3`, `teardownTimeout 60 s`, extra `enable_nodejs_*` flags; separate React (Playwright), node and type-test (`tests-d`) suites; a repo-wide coverage matrix in `design/test-coverage-matrix.md`; a `src/tests/capabilities` harness for Lifecycle capabilities [Agents-vitest][Agents-AGENTSmd]. | — |
| **Release, licence, footprint** | MIT [Agents-pkg]; 0.1.0 2025-09-10 → 0.22.0 2026-08-27 (22 minors, 197 stable releases counting an unrelated pre-2025 squat of the name; monthly counts 2026: Feb 9, Mar 18, Apr 15, May 8, Jun 13, Jul 5, Aug 2) [Agents-npm-time]; changesets-driven changelog; unpacked 5.28 MB / 232 files [Agents-npm]; ESM-only via tsdown [Agents-AGENTSmd]; runtime deps `capnweb`, `cron-schedule`, `mimetext`, `nanoid`, `partysocket`, `yaml`, `@cfworker/json-schema`, `esbuild`, `@babel/plugin-proposal-decorators`, `@rolldown/plugin-babel`; optional peers `ai`, `@ai-sdk/react`, `@tanstack/ai`, `react`, `vite`, `@cloudflare/codemode`, `chat`, `just-bash`, `@x402/*`; required peers `zod ^4`, `@modelcontextprotocol/{client,server} 2.0.0`, `@modelcontextprotocol/sdk 1.30.0` [Agents-pkg]. | No semver/support statement found on docs [Agents-limits][Agents-index] |

## 3. Mapping: karmi need → SDK coverage

| karmi need (from [RC §6], [HB §3], [PS §4]) | Coverage | What adopting it would dictate |
|---|---|---|
| **Session DO** (one SQLite DO per (Scope, session); cheap constructor; rehydrate from SQL) | Covered, heavily | Extending `Agent` = 7 framework tables + MCP manager + tracing + method auto-wrapping on every wake [Agents-ctor]; `Agent` is the DO, karmi's Session would be a subclass, not an owner. |
| **Scope keying** (every Primitive, secret and config resolves under Scope) | Not covered | Instance name is the only key; `props` header on first request is the only per-instance input [Agents-routing-src]. karmi would wrap `routeAgentRequest` or bypass it with `getAgentByName(ns, \`${scope}:${session}\`)`. |
| **Streaming to Channels** (turn/message/delta events, monotonic ids, replay on reconnect [HB §2.3]) | Partial | Generic layer: `broadcast(string)` + whole-state sync, no event log [Agents-ws]. Chat layer: `ResumableStream` replays **AI SDK `UIMessageChunk`s** and speaks the AI SDK UI stream protocol [AIChat-src][AIChat-docs]. Adopting it fixes the wire format to AI SDK v6/v7. |
| **Scheduling on one alarm** (continue/retry ticks, delayed resume) | Covered | Method-name callbacks resolved on `this`, retry policy, dedup rules, `keepAlive` heartbeat [Agents-sched][Agents-scheduler-src]. Fine if karmi is an `Agent`; the standalone `Scheduler` requires `Lifecycle` (experimental). |
| **MCP consumption as a Capability** (per-Scope registry, OAuth, tool filtering) | Covered, best-in-class | Registry is per-DO (`cf_agents_mcp_servers`), OAuth keys per DO storage, callback route interception on the Agent's own URL [Agents-mcp-client-src][Agents-oauth-src]. A per-Scope registry shared across sessions would need a separate DO per Scope running the manager and an RPC hop, or karmi's own table. Exact-pinned `@modelcontextprotocol/client 2.0.0` [Agents-pkg]. |
| **Provider seam** (own `Provider.stream()`, direct Anthropic adapter + AI SDK `doStream()` [PS §1]) | Conflicts at the chat/harness layer; neutral at the core | Core `agents` does not import `ai` (only `agent-tools.ts`, `skills/runner.ts`, and a type in `chat/lifecycle.ts`) [Agents-src-grep]. `@cloudflare/ai-chat` and Think are built on `streamText`/`UIMessage` end to end; Think pins `@ai-sdk/anthropic ^4` [AIChat-src][Think-pkg]. `MCPAITool` is structural (zod) so karmi could convert it [Agents-mcp-client-src]. |
| **Sub-agents** (child session, own transcript, parent gets result via callback [HB §2.7]) | Covered (different topology) | DO facets: colocated, root-owned alarm/sockets, `constructor.name` routing, experimental [Agents-subagent-src][Agents-rfc-subagents]. Cross-machine or cross-Scope children still need plain DOs. |
| **Permissions / approvals / hooks** (evaluator, durable pending-approval row, in-process hook bus [HB §3]) | Not covered generically | Only AI SDK `needsApproval` in the chat layer and `waitForApproval` in Workflows [AIChat-docs][Agents-workflow-src]. Think has "approvals, authorization" for server actions but inside its opinionated loop [Think-docs]. |
| **Compaction** (threshold, cut points, summary step, tail pointer [HB §2.4]) | Partial, experimental | Sessions' overlay compaction with `protectHead`/`tailTokenBudget`/tool-pair alignment and FTS5 [Sessions]; the summariser is an AI SDK `generateText` call in the example. Tree transcript matches [HB §4] open question 3. |
| **Sandbox Capability** (Containers/Sandbox SDK, Dynamic Workers [RC §3]) | Docs pattern only | `getSandbox(env.Sandbox, this.name)`; nothing in the Agent class [Agents-sandbox]. `@cloudflare/shell`, `codemode`, `worker-bundler` are separate packages [Agents-tree]. |
| **Workers-for-Platforms isolation per Scope** | Not covered | No reference in source [Agents-src-grep]. `routeAgentRequest` would work inside a user Worker, but dispatch, per-tenant limits and egress are outside the SDK. |
| **Multi-client fan-out per session** | Covered | Hibernating sockets, tags, readonly connections, broadcast-exclude, protocol-frame opt-out [Agents-ws]. |
| **Long unattended loops** (Workflows, `waitForEvent` [RC §6]) | Covered | `runWorkflow` + `AgentWorkflow` callbacks by name, sub-agent runs facet-local [Agents-workflow-src]. Fibers cover in-DO recovery [Agents-durable]. |
| **Observability hooks** | Covered | `diagnostics_channel` events and GenAI spans; requires `nodejs_compat` [Agents-obs-src][Agents-tracing]. |
| **Testing** | Pattern | Same `vitest-pool-workers` setup karmi already planned [RC §2]; the SDK adds `retry: 3` and per-suite wranglers [Agents-vitest]. |
| **Email / webhook Channels** | Covered (email) | `routeAgentEmail` resolvers and signed reply headers [Agents-email-src]; Think messengers via the `chat` SDK [Think-readme]. Channels live outside karmi anyway [CONTEXT]. |

## 4. Lock-in and seam analysis

1. **DO-only base class.** `Agent extends DurableObject` and imports `cloudflare:workers` in six files [Agents-src-grep]. Nothing in `agents` runs outside workerd. This does not add lock-in beyond [RC] (karmi already chose DO), but it closes the "clean seam for a second runtime" [RC §7] completely: karmi's public `Agent` Primitive would *be* a Cloudflare class.
2. **Storage schema ownership.** Seven `cf_agents_*` tables plus `cf_ai_chat_*`, `assistant_*`, `cf_agents_mcp_servers` with the SDK's own migrations (`_ensureSchema`, schema-version row, JIT id migrations) live in the same SQLite as karmi's transcript [Agents-ctor][AIChat-src]. Swapping out later means a data migration of every live session, not a code change.
3. **AI SDK types at rest.** The chat layer's persisted unit is `UIMessage` and its wire unit is `UIMessageChunk` [AIChat-src]. That is exactly the coupling [PS §1] rejected. Core `agents` avoids it deliberately (`MCPAITool` structural, `ai` optional peer) [Agents-mcp-client-src][Agents-pkg], which is the pattern to copy.
4. **Routing conventions.** `/agents/{class}/{name}` and `/sub/...` are literal tokens in the router, the client and the sub-agent path builder ("not configurable") [Agents-subrouting-src]. `prefix` is the only knob [Agents-routing-src]. karmi's Channel adapters would inherit this URL shape or reimplement `routeAgentRequest`.
5. **MCP handling.** Per-DO registry, OAuth callback intercepted on the DO's own route, SDK-v2 client pinned exact [Agents-mcp-client-src][Agents-pkg]. Good defaults, but the Scope-level registry [HB §3] and karmi's own capability gating would sit awkwardly on top.
6. **Hidden runtime behaviour.** Method auto-wrapping (`_autoWrapCustomMethods`), tracing spans on every wake, alarm housekeeping appended to `onAlarm`, keep-alive refs, fiber recovery scans with backoff and memory-strike counters [Agents-ctor][Agents-options-src]. These are correct but opaque; debugging a karmi Harness turn would mean reading a 12,000-line file.
7. **Own agent loop.** The SDK has two loops (`@cloudflare/ai-chat`'s `onChatMessage`/`streamText` and Think's `runTurn`) and both are AI SDK-driven [AIChat-docs][Think-docs]. karmi owns its loop [HB §3], so building ON would use `Agent` only as a DO shell while ignoring the parts Cloudflare is investing in most (chat recovery, Think) — paying the weight without the benefit.
8. **Swap-out cost, if ON were chosen anyway:** rewriting the DO base, scheduler, WS protocol and MCP registry, then migrating every session's SQLite. If BESIDE: zero, because nothing is shared at runtime.

Conflicts with standing preferences, summarised: clean seams for a second runtime (conflict, absolute); own agent loop (neutral at core, conflict at chat/Think); own provider seam (conflict at chat/Think); Scope as the isolation key (unsupported); Workers for Platforms (unaddressed).

## 5. Options

### 5.1 Build ON (karmi's session DO extends `Agent`; Harness in `onMessage`/`onRequest`; use `schedule`, `mcp`, `subAgent`, `runFiber`)

Pros: scheduler, keep-alive, fibers, hibernating sockets, MCP client with OAuth, facets, Workflow callbacks, observability and the React client for free; Cloudflare's team maintains DO-platform edge cases (alarm arbitration, eviction, code-update resets — `isDurableObjectCodeUpdateReset` in `retries.ts`) [Agents-scheduler-src]; large test corpus.
Cons: items 1–8 of section 4; 0.x cadence with renames inside minors; 5 MB install with bundler deps; exact-pinned MCP peers; `nodejs_compat` and decorator transform mandatory; karmi's public `Agent` Primitive would expose `Agent`'s ~40 public methods (`setState`, `broadcast`, `queue`, `schedule`, `subAgent`…) unless wrapped, and wrapping a class hierarchy is not a seam.
Risks: a minor bump changes schema or protocol under live sessions; Cloudflare's roadmap (Think, channels, voice) pulls the base class towards their harness; if karmi's Harness needs a different persistence unit, two transcripts coexist.

### 5.2 Build BESIDE (own thin DO base; own tables; own event stream; borrow designs; vendor small pieces)

Pros: karmi controls every persisted byte and every wake-path cost; the DO base can stay ~few hundred lines; a second-runtime seam remains conceivable (the base class is the only Cloudflare-specific file); provider seam decision stands; Scope becomes a first-class key in the DO name and in every table.
Cons: karmi re-implements alarm multiplexing, keep-alive, fiber-style recovery, hibernation-safe connection state, MCP OAuth in a DO, sub-agent plumbing; loses `useAgent`/`useAgentChat` unless karmi speaks a compatible protocol at the Channel edge; must track Cloudflare platform changes itself.
Risks: divergence from Cloudflare's idioms makes future adoption of their tooling (tracing attributes, Think extensions, channels packages) harder; under-estimating the recovery engine (the SDK's `recovery-engine.ts` is 43 KB and `recovery-incident.ts` 33 KB [Agents-tree]).

### 5.3 IGNORE

Pros: none beyond not reading it.
Cons: repeats mistakes the SDK already fixed (facet body buffering, alarm re-arm races, OAuth key migration, SSRF, React render storms on replay — all visible in the 0.21/0.22 changelog) [Agents-changelog].

### 5.4 Middle paths

- **Depend on `agents/mcp/client` only.** Blocked in 0.22.0: requires `Lifecycle` installation [Agents-changelog]; brings exact-pinned MCP peers and `node:async_hooks`. Revisit if the capability becomes standalone again.
- **Depend on `agents/schedules` only.** Same dependency on `Lifecycle`; the parser (`agents/schedules/parser`, zod) is standalone but trivial [Agents-AGENTSmd].
- **Compose `agents/lifecycle` in karmi's own DO.** The most attractive future path: `Lifecycle.install(this)` on a plain `DurableObject` gives alarm arbitration, hibernating sockets and a job queue without `Agent`'s tables [Agents-lifecycle-upstream][Agents-lifecycle-index]. Today `@experimental`; nothing in karmi's persisted state would depend on it, so it could be adopted later behind karmi's own `SessionHost` interface without a migration. Recommended as the **first re-evaluation checkpoint**.
- **Vendor pieces** (section 7). Chosen for v0.
- **Speak the SDK's client protocol at the Channel edge** (`{type:"rpc"}` frames, `cf_agent_state`, or `agents/chat/transport`) so `useAgent`/`useAgentChat` work against karmi. Cheap for the RPC/state frames; expensive and AI-SDK-coupled for chat. Defer; Channels are outside karmi [CONTEXT].

## 6. Recommendation, restated with rationale

Build **beside**. karmi's session DO is a plain `DurableObject` subclass with: a Scope-qualified name, its own `sessions`/`events`/`jobs`/`mcp_servers` tables, one alarm driven by a jobs table (SDK pattern), hibernating sockets with attachment-backed connection state (SDK pattern), and karmi's own `ProviderEvent` stream [PS §4] as the only thing that leaves the DO. The Harness loop, permission evaluator, hook bus, compaction and sub-agent plumbing are karmi's [HB §3]. Nothing from `agents` is imported at runtime in v0.

Rationale in one line each: the SDK's value is concentrated in layers karmi must own anyway (chat loop, persistence shape); its generic layer is good but experimental in exactly the composable form karmi would want; its stability record is a 0.x record; and the borrowable knowledge transfers without the dependency.

Re-evaluation triggers: `agents` 1.0 with a support statement; `agents/lifecycle` stabilised; or an explicit product decision that the AI SDK React UI is karmi's primary Channel.

## 7. What to borrow, what to avoid

Borrow (patterns; cite the file when reimplementing):

1. **Single-alarm job queue.** `lifecycle/job-queue.ts`, `lifecycle/job-driver.ts`, `schedules/scheduler.ts`: jobs table with `fn` + payload + resolved retry policy; Lifecycle "selects, runs, and rearms the shared alarm"; capabilities contribute wake times; recurring-vs-one-shot dedup rules; `hungScheduleTimeoutSeconds`; memory-limit strike counter; `isDurableObjectCodeUpdateReset` / `isPlatformFailure` classification in `retries.ts` [Agents-scheduler-src][Agents-lifecycle-upstream][Agents-options-src].
2. **Keep-alive heartbeat and fiber recovery.** `keepAlive()` ref-counting capped at `keepAliveIntervalMs`; `runFiber` row-before-run, `stash()` synchronous checkpoint, recovery scan with deadline, backoff and `fiberRecoveryMaxAgeMs` [Agents-durable][Agents-options-src].
3. **Hibernation discipline.** Mandatory hibernation, connection state in socket attachments, re-wrap after wake, tags for fan-out, protocol-frame opt-out for binary clients [Agents-ws][Agents-lifecycle-upstream][Agents-capability-src].
4. **MCP OAuth inside a DO.** `mcp/client/do-oauth-client-provider.ts` (15 KB, MIT): client-info/token/verifier/state keys under `ctx.storage`, nonce-bound state, discovery-state cleanup on success, legacy-key migration; plus `normalizeServerId` (≤64 chars) and the SSRF guard in `mcp/client/index.ts` [Agents-oauth-src][Agents-mcp-client-src]. Vendor with attribution.
5. **Structural tool type.** `MCPAITool` with zod schemas so the AI SDK is never imported into the core declaration graph [Agents-mcp-client-src] — the same trick karmi's `Tool` Primitive should use towards both adapters [PS §4].
6. **Sub-agents on facets.** `design/rfc-sub-agents.md` and `sub-routing.ts`: `SubAgentStub<T>` derived by excluding `keyof Agent`, `ctx.exports` validation, root-first path encoding, streamed body forwarding (not `arrayBuffer()`), root-owned alarm leases for facets [Agents-rfc-subagents][Agents-subrouting-src][Agents-changelog]. Decide facets-vs-DOs for karmi sub-agents (follow-up).
7. **Workflow→session callbacks by name**, with the caveat list in the `runWorkflow` docblock (name resolution, facet-local tracking, `keepNames`) [Agents-workflow-src].
8. **Signed reply-to email headers** and auto-reply detection [Agents-email-src] — for whichever Channel package implements email.
9. **Observability shape.** `diagnostics_channel` channel-per-domain with typed events, Tail Worker sink, GenAI semconv span names [Agents-obs-src][Agents-diag][Agents-tracing].
10. **Test layout.** One `wrangler.jsonc` per suite listing DO classes, `retry: 3`, capability harness objects, type tests in `tests-d` [Agents-vitest][Agents-AGENTSmd].
11. **Sessions' transcript tree and overlay compaction** (`parent_id`, `assistant_compactions`, `protectHead`/`tailTokenBudget`, tool-pair boundary alignment) as input to [HB §4] questions 3–4 [Sessions].
12. **Recovery engine scope** (`chat/recovery-engine.ts`, `recovery-incident.ts`, `stall-watchdog.ts`, `orphan-persist.ts`) as a checklist of failure modes a serverless Harness turn must handle [Agents-tree].

Avoid:

- Extending `Agent`, `AIChatAgent` or `Think`; persisting `UIMessage`; adopting the AI SDK UI stream as karmi's wire format [AIChat-src].
- Whole-state `setState` broadcast as the client sync model [Agents-state].
- `/agents/{class}/{name}` as karmi's public URL contract [Agents-subrouting-src].
- Method-name-string callbacks for scheduling in the public API (fine internally); karmi should schedule typed job kinds.
- `@callable()` decorators in the public Primitive API (bundler coupling) [Agents-readme].
- Taking `agents` as a dependency for one sub-module while it still pulls `esbuild`/babel and exact-pinned MCP peers [Agents-pkg].

## 8. References

Cloudflare Agents SDK — docs
[Agents-index]: https://developers.cloudflare.com/agents/
[Agents-class]: https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/
[Agents-state]: https://developers.cloudflare.com/agents/runtime/lifecycle/state/
[Sessions]: https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/
[Agents-routing]: https://developers.cloudflare.com/agents/runtime/communication/routing/
[Agents-ws]: https://developers.cloudflare.com/agents/runtime/communication/websockets/
[Agents-sched]: https://developers.cloudflare.com/agents/api-reference/schedule-tasks/ (also /agents/runtime/execution/schedule-tasks/)
[Agents-durable]: https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
[Agents-tracing]: https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/
[Agents-diag]: https://developers.cloudflare.com/agents/runtime/operations/observability/diagnostics-channels/
[Agents-mcp]: https://developers.cloudflare.com/agents/tools/mcp/
[Agents-sandbox]: https://developers.cloudflare.com/agents/tools/sandbox/
[AIChat-docs]: https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/
[Think-docs]: https://developers.cloudflare.com/agents/harnesses/think/
[Agents-limits]: https://developers.cloudflare.com/agents/platform/limits/
[DO-facets]: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ (found via search; `/durable-objects/api/facets/` returns 404)

Cloudflare Agents SDK — repository (github.com/cloudflare/agents, `main`, read 2026-08-29)
[Agents-pkg]: packages/agents/package.json (version 0.22.0, license, dependencies, peerDependencies, exports)
[Agents-npm]: `npm view agents` — version 0.22.0, modified 2026-08-27T13:29Z, dist.unpackedSize 5,282,222, fileCount 232
[Agents-npm-time]: `npm view agents time` — per-version publish dates (0.1.0 2025-09-10 … 0.22.0 2026-08-27)
[Agents-changelog]: packages/agents/CHANGELOG.md, entries 0.22.0 and 0.21.0
[Agents-readme]: packages/agents/README.md and README.md (decorator requirement, quick example)
[Agents-AGENTSmd]: packages/agents/AGENTS.md (export map, source layout, build, testing)
[Agents-tree]: GitHub tree API for packages/agents/src (file list and sizes) and packages/ listing (`agents, ai-chat, channels, codemode, hono-agents, shell, think, voice, worker-bundler`)
[Agents-ctor]: packages/agents/src/index.ts ~1531–1535 (class decl), ~1953 (`sql`), ~1990–2140 (`_ensureSchema` tables), ~2290–2440 (constructor: scheduler resolver, MCP manager, `lifecycle.use(...)`, hook-mode detection, `onAlarm` housekeeping wrapper)
[Agents-state-src]: packages/agents/src/index.ts ~1079–1088, ~1731–1803, ~2934–2994, ~3260–3289 (`cf_agents_state`, `initialState`, `setState`, `onStateChanged`/`onStateUpdate`)
[Agents-options-src]: packages/agents/src/index.ts ~1256–1345 (`DEFAULT_AGENT_STATIC_OPTIONS`, `AgentStaticOptions`)
[Agents-protocol-src]: packages/agents/src/index.ts ~196–235 (`RPCRequest`, `StateUpdateMessage`, `RPCResponse`)
[Agents-subagent-src]: packages/agents/src/index.ts ~7135–7165 (`subAgent` docblock, `@experimental`), ~400–420 (facet types), ~5557–5606 (`ctx.facets.delete`)
[Agents-workflow-src]: packages/agents/src/index.ts ~10180–10235 (`runWorkflow` docblock and constraints); packages/agents/src/workflows.ts (`AgentWorkflow`)
[Agents-scheduler-src]: packages/agents/src/schedules/scheduler.ts (header comment, `DEFAULT_RETRY`, schema v2, dedup rules)
[Agents-lifecycle-upstream]: packages/agents/src/lifecycle/UPSTREAM.md
[Agents-lifecycle-index]: packages/agents/src/lifecycle/index.ts (`@experimental Every export here may change`)
[Agents-capability-src]: packages/agents/src/lifecycle/capability.ts (`LifecycleServices`, `LifecycleSockets`, routes)
[Agents-routing-src]: packages/agents/src/agent-routing.ts (`routeAgentRequest`, options, kebab mapping, `x-agents-lifecycle-props`)
[Agents-subrouting-src]: packages/agents/src/sub-routing.ts (`SUB_PREFIX`, `buildAgentPath`, `@experimental`)
[Agents-callable-src]: packages/agents/src/callable-decorator.ts
[Agents-client-src]: packages/agents/src/client.ts and src/react.tsx (`AgentClient`, `useAgent`, `DEFAULT_CALL_TIMEOUT_MS`)
[Agents-mcp-client-src]: packages/agents/src/mcp/client/index.ts (`MCPAITool` ~54–70, `normalizeServerId`, SSRF guard ~145–260, `MCPClientManager extends LifecycleCapability` ~390, `cf_agents_mcp_servers`, `getAITools` ~2043)
[Agents-mcp-conn-src]: packages/agents/src/mcp/client/connection.ts ~347–383 (transport selection)
[Agents-oauth-src]: packages/agents/src/mcp/client/do-oauth-client-provider.ts
[Agents-mcp-server-index]: packages/agents/src/mcp/server/index.ts and src/mcp/index.ts
[Agents-mcp-legacy-src]: packages/agents/src/mcp/server/legacy-agent.ts ~40–55 (`@deprecated McpAgent is feature-frozen`)
[Agents-mcp-utils-src]: packages/agents/src/mcp/server/utils.ts (`createStreamingHttpHandler`, `streamable-http:${sessionId}`)
[Agents-email-src]: packages/agents/src/email.ts
[Agents-obs-src]: packages/agents/src/observability/index.ts
[Agents-vitest]: packages/agents/src/tests/vitest.config.ts and src/tests/wrangler.jsonc
[Agents-aichat-stub]: packages/agents/src/ai-chat-agent.ts (throws: "moved to @cloudflare/ai-chat")
[Agents-src-grep]: local grep over the downloaded `packages/agents/src` for `from "ai"`, `@tanstack/ai`, `node:`, `cloudflare:workers`, `Workers for Platforms|dispatch_namespace` (no WfP hits; `ai` imported only in `agent-tools.ts`, `skills/runner.ts`, `chat/lifecycle.ts`)
[Agents-rfc-subagents]: design/rfc-sub-agents.md (Status: accepted)
[AIChat-src]: packages/ai-chat/src/index.ts (`AIChatAgent`, `UIMessage`, `cf_ai_chat_agent_messages`, `ResumableStream`, ~386–880)
[AIChat-pkg]: packages/ai-chat/package.json (0.11.0; peers `ai ^6||^7`, `@ai-sdk/react`, `react`; export `./ai-chat-v5-migration`)
[Think-pkg]: packages/think/package.json (0.17.0; deps `@ai-sdk/anthropic ^4`, `@ai-sdk/openai ^4`, `workers-ai-provider ^4`, `@cloudflare/codemode`, `@cloudflare/shell`, `chat`, `just-bash`)
[Think-readme]: packages/think/README.md ("Experimental — the API surface is stable but may evolve")
[Codemode-pkg]: packages/codemode/package.json (0.5.1)
[Hono-pkg]: packages/hono-agents/package.json (3.0.12)

Internal
[RC]: docs/research/runtime-comparison.md (2026-08-28) §2, §3, §6, §7
[HB]: docs/research/harness-baseline.md (2026-08-28) §2.3, §2.4, §2.7, §3, §4
[PS]: docs/research/provider-seam.md (2026-08-29) §1, §2.1, §4
[CONTEXT]: CONTEXT.md glossary
