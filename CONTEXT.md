# karmi

A code-first TypeScript framework for building agent harnesses that run natively on a serverless runtime. An agent *platform* is a later product built with it, not part of it.

## Language

**Framework**:
karmi itself — the code-first library a developer uses to define and deploy agents on a serverless runtime.
_Avoid_: platform, SDK (when referring to karmi as a whole)

**Platform**:
A product built *with* the Framework that lets its own users run agents. Owns tenants, sign-up, billing. Out of karmi's scope.
_Avoid_: framework, app

**Harness**:
The runtime machinery that drives a model in a loop — tool calls, streaming, context management, permissions — as Claude Code, Codex and pi do locally.
_Avoid_: agent runner, executor

**Primitive**:
A first-class building block the Framework exposes above the Harness. The v0 set: Agent (from an Agent Spec), Tool, Prompt/Fragment, Skill, Thread, User, Connection, Memory, Knowledge/Retriever, Capability, Hook, Permission Policy. Scope keys them all.
_Avoid_: component, module, feature

**Channel**:
An external surface through which a human or event reaches a session — a chat UI, a chat app, inbound email, a webhook. Channel integrations live outside karmi.
_Avoid_: integration, connector, frontend

**Capability**:
A gated ability an Agent may be granted in its Agent Spec, such as running small generated scripts, outbound HTTP, remote MCP, long-running turns (`longRunning`: Step, wall-clock and token budgets), delegating to other Agents, or scheduling its own future wake-ups. The Catalogue implements it; the Spec switches it on; a Scope-level ceiling is merged as a maximum and a Spec asking for more is a validation error. Nothing not granted is reachable.
_Avoid_: permission, feature flag

**Script**:
Model-written code run under the `scripts` Capability through the built-in `run_script` Tool. Two tiers behind one `Sandbox` seam: `isolate` (v0 — JS in a Dynamic Worker with no filesystem, egress, secrets or storage; its only API is the Agent's allow-resolved Tools, every call re-entering the Harness gate) and `container` (Sandbox SDK; specified later). Nested Tool calls are child Thread events, not model context; files come back as `artifacts: MediaRef[]`.
_Avoid_: code execution, bash tool, sandbox (for the script itself), function calling

**Tool**:
A named action an Agent can call: a JSON-Schema input, annotations (read-only, destructive, …), optional usage instructions as a Fragment, an optional required Connection, and code that executes it. Arrives from the Catalogue (code), from a remote MCP server (runtime, named `server__tool`), or as a Framework built-in; identical to an Agent Spec either way.
_Avoid_: function, action, integration, capability

**Provider Tool**:
A Tool the model's provider executes inside its own turn — web search, web fetch, provider-side code execution — never the Harness. Granted through the `providerTools` Capability by abstract name; the provider adapter maps it to the native definition. Policy can only include or exclude it from the request (never `ask`); its call and byte-exact result are logged as `server_tool` events, distinct from Harness Tool events.
_Avoid_: server tool, hosted tool, built-in tool, native tool

**Permission Policy**:
Data in an Agent Spec: ordered rules matching Tools by name and annotation, each resolving to allow, ask (pause for a human) or deny. Scope-wide defaults are merged into the Spec by the Platform; the Framework sees one resolved policy per Agent.
_Avoid_: permission rules, ACL, guardrails

**Hook**:
A Catalogue item — code that runs at a lifecycle point (before a tool call, after a turn, on error) — attached to an Agent by name in its Spec.
_Avoid_: middleware, plugin, interceptor, callback

**Scope**:
The isolation key every Primitive and all secrets/config resolve under, identified by an opaque string the Platform mints and the Framework never interprets. Nothing in one Scope can see another; the Framework offers no cross-Scope operation. A Scope is active, suspended, destroying or destroyed; suspension is reversible, while destruction permanently reserves its identity. The Platform decides what a Scope represents (a tenant, a user, a workspace) and keeps the list of them.
_Avoid_: tenant, organisation, account, workspace

**Deployment**:
One installation of the Framework — a Worker with its Catalogue and deployment-wide defaults (providers, ceilings, policy) that every Scope inherits and may only tighten.
_Avoid_: environment, instance, app

**Provider credential**:
A secret that authorises model-provider calls for one Scope. The Platform is its authority; the Framework may hold it in its default secret store or resolve it from a Platform-supplied secret store, but it is never part of an Agent Spec or Thread.
_Avoid_: API key, BYOK key, provider config, Connection

**Provider profile**:
A named provider account available to a Scope, combining an adapter, gateway settings, model compatibility and a reference to either a Scope-owned or Deployment-owned Provider credential. An Agent selects a profile; `default` is only a conventional name, never an implicit fallback.
_Avoid_: provider, account, API-key config, credential

**User**:
The principal an Agent is acting for or with — the person chatting, or the person whose events are being processed. Keyed under a Scope; a Scope has many Users. Per-User things (profile, memory, history, user-level Connections) live under (Scope, User). The caller maps channel identities to a User before the Framework sees them; the Framework never authenticates.
_Avoid_: end user, customer, principal, account

**Thread**:
One durable conversation between one Agent and one User, keyed (Scope, Agent, User, threadId); User may be absent for user-less Events. Driven by Turn inputs — User messages or Events. Holds the transcript and can be resumed or forked. A Thread opened by Delegation is a child of the delegating Thread, acting for the same User. Whether a User gets one Thread or many with an Agent is decided by the Channel binding, not by the Agent. A User's chat history with an Agent is simply their Threads with it.
_Avoid_: session, conversation, chat, channel

**Turn**:
One run of the Harness loop on a Thread, from a Turn input to `turn.completed` or `turn.failed`. Driven entirely by the Thread's Durable Object as a sequence of Steps, whoever triggered it; a connected client only subscribes. One Turn at a time per Thread; a Turn may be **parked** (awaiting an approval, a scheduled wait, a budget `continue`, or a Job) and still holds the Thread while parked.
_Avoid_: request, run, session, invocation

**Step**:
The unit of a Turn that is persisted and recovered at a boundary: a **model Step** (one streamed model call) or a **tool Step** (one tool batch — parallel read-only Tools, or one mutating Tool). The event log is the only state at a boundary; after an eviction the unfinished Step re-runs, and a half-finished tool Step re-runs only Tools with no persisted result. Steps are kicked in-process; the DO alarm is a watchdog, not the driver.
_Avoid_: iteration, tick, workflow step, phase

**Job**:
Durable work that outlives one Durable Object invocation and runs outside the Thread — a container-tier Script, a slow remote Tool, bulk Knowledge ingestion. Started by a Tool that returns `{ pending: jobId }`, which parks its tool Step; progress and completion re-enter the Thread as Events carrying `MediaRef`s. The interface is v0; a Cloudflare Workflow implementation is deferred until a Tool needs it.
_Avoid_: workflow, task, background task, async tool

**Event**:
A non-chat Turn input: a typed JSON payload from a webhook, queue or Schedule, concerning a User (or none), delivered into a Thread by the Channel binding (or by the Thread's own Schedule) and shown to the Agent through a Fragment. Not a Primitive of its own.
_Avoid_: trigger (for the input), message, notification, job

**Schedule**:
An Event a Thread will receive at a future time — once (`at`, `delay`) or repeatedly (`cron`). Belongs to the Thread it wakes; created by code through the Thread API, or by the Agent itself for its own Thread under the `scheduling` Capability. A firing is an ordinary Turn input and follows the one-Turn-at-a-time rule; a recurring Schedule holds at most one undelivered firing. The only public face of the Framework's timer — Step watchdogs and parked-Turn timeouts ride the same alarm but are not Schedules.
_Avoid_: job, cron job, timer, alarm (for the public thing), reminder (as the concept)

**Connection**:
A named, typed credential grant a Tool acts through, held at one of two levels: agent-level (Scope, Agent, name) — shared by every User of that Agent — or user-level (Scope, User, name) — granted by the User so the Agent acts on their behalf, usable across every Agent in the Scope. A Tool requires a Connection by name; user-level resolves before agent-level. An MCP server declares its level in ScopeConfig (`auth: none | static | oauth { level }`); an OAuth grant is the Connection `mcp:<serverId>`, its refresh token never leaves ScopeConfig, and a missing grant surfaces as an `approval.requested { kind: "connect" }` pause.
_Avoid_: credential, integration, token, secret (for the grant itself)

**Prompt**:
An Agent's instructions, composed from ordered Fragments evaluated at the start of every turn. Never a static string, never persisted.
_Avoid_: system prompt (as the definition), template, instructions (for the whole)

**Fragment**:
A named, reusable piece of a Prompt: a function of the turn's context (model, Scope, User, Thread, available Tools, time) returning text or nothing. Agent base instructions, model-specific variants, Tool usage instructions and per-User context are all Fragments.
_Avoid_: section, snippet, partial, context provider

**Skill**:
A named procedure an Agent can load on demand: a description the model always sees, a body Fragment that enters context only when invoked (by the model, by a User command, or both), and optional Tools that exist only while it is active. Attached to an Agent by reference, defined in code.
_Avoid_: command, slash command, plugin, playbook

**Memory**:
What Agents accumulate about a User across Threads, keyed (Scope, User) and shared by every Agent in the Scope: a structured Profile (developer-defined fields) plus free-form Notes. Reaches the model through a Fragment and the `remember`/`recall` Tools. Data the Platform already holds about a User (orders, CRM) is not Memory — it is injected by a Fragment.
_Avoid_: long-term memory, user data, history, knowledge

**Knowledge**:
A named corpus of documents an Agent answers from, keyed (Scope, name), identical for every User and attached to an Agent by reference. Ingested in bulk; searched through a Retriever. Reaches the model as a Fragment (whole corpus, for small ones) or a search Tool.
_Avoid_: knowledge base, KB, RAG, memory, documents (for the corpus)

**Retriever**:
The strategy behind a Knowledge search or a Memory recall: given a query, return ranked passages. A Catalogue item; full-text (FTS5 in the Knowledge's own SQLite) is the default, vector similarity and hybrid (BM25 + vector, rank-fused) sit behind the same seam. The Framework owns chunking and the embedding call; a **Vector store** is only the mirror the vector Retriever writes to.
_Avoid_: vector store (for the strategy), index, embeddings (for the strategy), RAG

**Vector store**:
Where a vector Retriever keeps embeddings, keyed by Scope: the Knowledge's own SQLite (brute-force, the default and the only one tests need) or Cloudflare Vectorize (one index per Deployment per embedding model, namespace = Scope). The Knowledge's chunk ledger is the truth; the store is a mirror rebuilt or emptied from it. The embedding model, dimensions and metric are a Knowledge-level fact fixed at first ingest.
_Avoid_: index (for the store), database, Vectorize (as the generic term)

**Agent**:
A configured actor the Framework runs: created from an Agent Spec and keyed (Scope, agentId). A Scope may hold any number of Agents, created at runtime by the Platform or written in code — same shape either way.
_Avoid_: bot, assistant, persona, agent definition (for the running thing)

**Agent Spec**:
The plain-data description an Agent is born from, identified by a caller-chosen `agentId` under a Scope: name, ordered Prompt entries (with per-model variants), model choice, references by name to Catalogue items — Tools, Skills, Knowledge, Retrievers, Hooks — each optionally carrying settings, plus Connection declarations (never credentials), Capability grants, a Memory profile schema and a Permission Policy. Contains no code. The Framework validates it against the Scope it is stored in and reports errors and warnings; a stored Spec carries a version the Framework mints, and a Turn works from one snapshot of it start to finish.
_Avoid_: config, definition file, manifest, template

**Prompt entry**:
One item in an Agent Spec's ordered instructions: either literal text or a Catalogue Fragment by name with arguments, optionally limited to matching models. Every entry becomes a Fragment when the Prompt is evaluated.
_Avoid_: prompt section, variant (for the entry), template

**Catalogue**:
Everything a developer defines in code and deploys with the Framework, available for Agent Specs to reference by name: Tools, Fragments, Skills, Retrievers, Hooks, Deliverers, code-defined Agents. Items are pure definitions assembled explicitly at boot; names are unique per kind. Shared by every Scope; the only place behaviour code lives. Describable as data so a Platform can build its editors from it.
_Avoid_: registry, library, plugins, toolbox

**Channel binding**:
Developer code in the Framework user's Worker that adapts one Channel to a Thread: maps external identities to (Scope, User), chooses the `threadId`, uploads media, calls `thread.send()`, and registers a Deliverer for replies. Lives outside karmi; talks only to the Thread API.
_Avoid_: integration, adapter, connector, plugin

**Turn input**:
What drives one turn of a Thread: a User message (text and media Parts) or an Event. Carries an opaque `channelRef` the Channel binding uses to reply in place.
_Avoid_: request, prompt, payload

**Thread event**:
One entry in a Thread's ordered, persisted event log (`seq`-numbered): turn start/end, Step start/end, turn paused/resumed, streamed deltas, completed parts, tool calls and results, approval requests, Job progress, compaction. The single outbound shape — the transcript is derived from it, and clients replay from a `seq`.
_Avoid_: message (for the log entry), stream chunk, notification

**Compaction**:
A Harness Step that shrinks a Thread's model context when `contextTokens > window - reserveTokens`: walk back to a Turn boundary keeping `keepRecentTokens`, summarise everything before it, and append a `thread.compacted { firstKeptSeq, summary }` event. The log is never rewritten; the next context is Prompt + summary + events after `firstKeptSeq`. Summarising is client-side by default or delegated to the provider (Anthropic's `compaction` block) by config; `before-compact` / `after-compact` Hooks wrap it either way.
_Avoid_: summarisation (for the Step), truncation, pruning, context reset

**Spill**:
The Harness rule that every tool result over the Agent's `context.toolOutput` limit is stored whole in R2 under the Thread as a `MediaRef` and shown to the model as head + tail + a truncation marker; the built-in `read_output` Tool re-reads it by ref. Always on, not a Capability.
_Avoid_: overflow, artifact (for spilled output), truncation (for the storage)

**Deferred Tool**:
A Tool the Agent may call but whose definition is kept out of the model's context until loaded: the model sees only its name in an index and loads it through the always-present `tool_search` built-in. Which Tools defer is a `context.tools` setting on the Agent Spec (`auto` — defer all deferrable Tools once their definitions exceed a share of the window — `always`, or `never`), with per-reference `alwaysLoad` pins; Framework built-ins and Skill Tools never defer. A load is a `tools.loaded` Thread event, so loaded Tools persist across Turns until Compaction drops them. Permission Policy applies to the whole Tool set before deferral: denied Tools are never indexed, `ask` Tools pause at call time as usual.
_Avoid_: lazy tool, hidden tool, tool search (for the Tool itself), dynamic tools

**Deliverer**:
A Catalogue item — code, by name — that pushes a Thread's output to a Channel when no live subscriber is attached. Chosen per Thread from the last inbound input; invoked from a Queue, at-least-once.
_Avoid_: webhook, callback, notifier, sender

**Delegation**:
One Agent handing a task to another Agent in the same Scope and receiving its result. The parent's Agent Spec lists, by name, the Agents it may delegate to; nothing not listed is reachable. The child runs under its own Agent Spec, in its own Thread, with fresh context and the parent's User; the parent receives only the child's final reply. Gated by a Capability. There is no separate "sub-agent" kind of thing — only Agents and the act of delegating.
_Avoid_: sub-agent (for the child Agent), spawn, orchestration, handoff

**Usage record**:
A `usage.recorded` Thread event the Harness persists in the same transaction as the Step it accounts for — kind `model` (tokens incl. cache and reasoning, model, provider, `serverToolCalls`), `compaction` or `script` (tier, wall ms) — stamped with `{ scope, agent, user?, threadId, parent?, turn, seq }`. Carries `cost { amount, currency, source, basis }` only when the provider or gateway reported one in the response (OpenRouter `usage.cost`, Vercel AI Gateway `providerMetadata.gateway.cost` — both on the final stream part); Cloudflare AI Gateway reports no cost in the response, so the record keeps its `cf-aig-log-id` under `gateway` for the Platform to join against the gateway log instead. karmi never prices tokens. Child Threads record their own with `parent` set; nothing is counted twice.
_Avoid_: metric, billing event, usage log, telemetry

**UsageHandler**:
A Catalogue item the Platform supplies to receive Usage records in batches, at-least-once via a Queue with `threadId:seq` as the idempotency key — the billing seam. Its failure retries and never fails a Turn. karmi keeps no per-Scope counters; Scope-wide spend limits are the Platform's, enforced through this handler.
_Avoid_: billing hook, metering, usage callback, meter

**Approval**:
A pause in a Turn that only a human answer can end, surfaced as an `approval.requested` Thread event and resolved by an `approval.resolved` one. Three kinds: `tool` (a Permission Policy `ask` on a Tool call), `continue` (a `longRunning` budget exhausted) and `connect` (a missing user-level Connection, answered by completing OAuth). The Framework records who answered (`by`) but never authorises the answerer — the Platform does. An answer is `allow` or `deny`, never an edit of the call; a timeout (`approvals.timeout`, Scope ceiling as max) and a Turn cancel are denies. Allowed calls in the same tool batch run before the pause; a denied call is an `isError` Tool result the model sees next. An `allow` may be remembered for the rest of the Thread, by Tool name only. A delegated child's Approvals are re-emitted on its parent Thread and answered there.
_Avoid_: permission prompt, confirmation, consent (for the pause), HITL request
