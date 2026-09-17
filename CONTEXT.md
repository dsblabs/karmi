# karmi

A code-first TypeScript framework for building agent harnesses that run natively on a serverless runtime. An agent _platform_ is a later product built with it, not part of it.

## Language

**Framework**:
karmi itself — the code-first library a developer uses to define and deploy agents on a serverless runtime.
_Avoid_: platform, SDK (when referring to karmi as a whole)

**Platform**:
A product built _with_ the Framework that lets its own users run agents. Owns tenants, sign-up, billing. Out of karmi's scope.
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

**Deliverer**:
A named Catalogue callback for a Channel’s offline output. The Thread remembers `channelRef.deliverer { name, ref }`; completion and Approval events reach the callback through the Queue when no Subscriber is attached, at least once, at its chosen event granularity.
_Avoid_: notification service, Channel integration (for the Framework callback)

**Capability**:
A gated ability an Agent may be granted in its Agent Spec, such as running small generated scripts, outbound HTTP, remote MCP, long-running turns (`longRunning`: Step, wall-clock and token budgets), delegating to other Agents, or scheduling its own future wake-ups. The Catalogue implements it; the Spec switches it on; a Scope-level ceiling is merged as a maximum and a Spec asking for more is a validation error. Nothing not granted is reachable.
_Avoid_: permission, feature flag

**Script**:
Model-written code run under the `scripts` Capability through the built-in `run_script` Tool. Two tiers behind one `Sandbox` seam: `isolate` (v0 — JS in a Dynamic Worker with no filesystem, egress, secrets or storage; its only API is the Agent's allow-resolved Tools, every call re-entering the Harness gate) and `container` (shell or Python in a Sandbox SDK container with a Workspace, allow-listed egress and no Tool bridge). Nested Tool calls are child Thread events, not model context; files come back as `artifacts: MediaRef[]`. A container Script still running at `wallMs` is promoted to a Job. A Script reaches every allow-resolved Tool whether or not the model has loaded it: the deferred loaded set gates model calls only.
_Avoid_: code execution, bash tool, sandbox (for the script itself), function calling

**Workspace**:
The disk of a container-tier Script: one container per Thread, created on the first `run_script` of a Turn and destroyed at Turn end (or after `idleMs`, cancel, or Thread destroy). An ephemeral cache, never durable truth — `/in` is materialised from the `MediaRef`s a call names, `/out` is exported to R2 as artifacts when the Script finishes, everything else may vanish at any time.
_Avoid_: session filesystem, virtual filesystem, persistent volume

**Tool**:
A named action an Agent can call: a JSON-Schema input, annotations (read-only, destructive, …), optional usage instructions as a Fragment, an optional required Connection, and code that executes it. Arrives from the Catalogue (code), from a remote MCP server (runtime, named `server__tool`), or as a Framework built-in; identical to an Agent Spec either way.
_Avoid_: function, action, integration, capability

**Provider Tool**:
A Tool the model's provider executes inside its own turn — web search, web fetch, provider-side code execution — never the Harness. Granted through the `providerTools` Capability by abstract name; the provider adapter maps it to the native definition. Policy can only include or exclude it from the request (never `ask`); its call and byte-exact result are logged as `server_tool` events, distinct from Harness Tool events.
_Avoid_: server tool, hosted tool, built-in tool, native tool

**Permission Policy**:
Data in an Agent Spec: ordered rules matching Tools by name and annotation, each resolving to allow, ask (pause for a human) or deny. Scope config and Deployment defaults carry rules of their own; the Framework resolves one policy per Agent, consulting the Scope's rules first, then the Deployment's, then the Spec's own.
_Avoid_: permission rules, ACL, guardrails

**Hook**:
A Catalogue item — code that runs at a lifecycle point (before a tool call, after a turn, on error) — attached to an Agent by name in its Spec.
_Avoid_: middleware, plugin, interceptor, callback

**Scope**:
The isolation key every Primitive and all secrets/config resolve under, identified by an opaque string the Platform mints and the Framework never interprets. Nothing in one Scope can see another; the Framework offers no cross-Scope operation. A Scope is active, suspended, destroying or destroyed; suspension is reversible, while destruction permanently reserves its identity. The Platform decides what a Scope represents (a tenant, a user, a workspace) and keeps the list of them.
_Avoid_: tenant, organisation, account, workspace

**Destroy walk**:
The maintenance job `scope.destroy()` leaves behind. The tombstone is written at once, and the walk then runs on the ScopeConfig alarm in idempotent batches — external credential revocations, Threads (Delegation children included), Memories, Knowledge corpora with their Retriever mirrors, the `{scope}/` R2 prefix, and last the Scope's own tables — until only the tombstone and the operation row are left. `scope.destroyStatus(operationId)` reports the phase, the counts and whatever a Secrets provider karmi does not own was asked to revoke.
_Avoid_: cleanup job, garbage collection, purge

**Deployment**:
One installation of the Framework — a Worker with its Catalogue and deployment-wide defaults (providers, ceilings, policy) that every Scope inherits and may only tighten.
_Avoid_: environment, instance, app

**Provider credential**:
A secret that authorises model-provider calls for one Scope, referenced from a Provider profile as `scope:<name>` (Scope-owned, put write-only through `scope.credentials`) or `deployment:<name>` (Deployment-owned, from `createKarmi({ credentials })`). The Platform is its authority; the Framework holds it in the default envelope store or resolves it from a Platform-supplied Secrets provider, but it is never part of an Agent Spec, a config revision, an event or a Turn snapshot. Resolved just in time before each model Step and discarded after the request is built, so a revocation lands at the next Step.
_Avoid_: API key, BYOK key, provider config, Connection

**Secrets provider**:
The seam a Provider credential resolves through: `resolve(ref)` to a Sensitive value, `describe(ref)` for metadata, optional `put`, `revoke`, `rewrap` and `list`. The default is the envelope store: one data key per credential, wrapped by the active key of a versioned Deployment key ring (`KARMI_KEYRING`), rows in the Scope's ScopeConfig, ciphertext bound to deployment, Scope, name and version. The Test kit's is in-memory.
_Avoid_: vault, key store, secret manager (for the seam)

**Sensitive value**:
The only form in which a credential travels inside the Framework: a wrapper that refuses JSON, string coercion and inspection, loses its value under structured clone, and yields it only through `expose()` in a Provider adapter's request builder. Loggers redact it.
_Avoid_: secret string, credential value, token (for the wrapper)

**Credential fallback**:
A Provider profile's opt-in to run under a named Deployment profile instead of its own when its credential is `missing` (the default reason) or a call fails with `auth`, `quota`, `rate_limit` or `unavailable`. Missing is decided at each Step start; a Provider error engages the fallback for the rest of the Turn, retrying the same model first. Every fallback is recorded on `step.started` with its reason and the credential source and version used.
_Avoid_: key rotation (for this), retry, model fallback (that is `model.fallbacks`)

**Provider profile**:
A named provider account available to a Scope, combining an adapter, gateway settings, model compatibility and a reference to either a Scope-owned or Deployment-owned Provider credential. An Agent selects a profile by name; a Spec that names none runs under `default` when the Scope has one, or the Scope's only profile. `default` is a conventional name, never a fallback for a profile that does not exist.
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

**Park**:
The state of a Turn that has stopped to wait, still holding its Thread: for an Approval, a Job, a budget `continue`, an OAuth consent, or a suspended Scope. A parked Turn resumes from its log when the answer arrives; it is neither running nor finished.
_Avoid_: pause (for the state), suspend (that is a Scope), block

**Tombstone**:
The row a destroyed Thread, Agent or Scope leaves behind so its identity is never reused. A tombstoned item refuses every operation except the lifecycle reads that report on it; the durable cleanup behind it runs later in scheduler batches.
_Avoid_: soft delete, deleted flag

**Step**:
The unit of a Turn that is persisted and recovered at a boundary: a **model Step** (one streamed model call) or a **tool Step** (one tool batch — parallel read-only Tools, or one mutating Tool). The event log is the only state at a boundary; after an eviction the unfinished Step re-runs, and a half-finished tool Step re-runs only Tools with no persisted result — and only those annotated read-only or idempotent; any other unfinished call gets a Harness-synthesised **interrupted** result (`isError`, `interrupted: { attempt }`) telling the model the action may or may not have happened, never a silent second run. Steps are kicked in-process; the DO alarm is a watchdog, not the driver.
_Avoid_: iteration, tick, workflow step, phase

**Job**:
Durable work that outlives one Durable Object invocation and runs outside the Thread — a container-tier Script, a slow remote Tool, bulk Knowledge ingestion. Started by a Tool that returns `{ pending: jobId }`, which parks its tool Step; progress and completion re-enter the Thread as Events carrying `MediaRef`s. The interface is v0; a Cloudflare Workflow implementation is deferred until a Tool needs it.
_Avoid_: workflow, task, background task, async tool

**Event**:
A non-chat Turn input: a typed JSON payload from a webhook, queue, fleet cron or Schedule, concerning a User (or none), delivered into a Thread by the caller's own code (or by the Thread's own Schedule) and shown to the Agent through a Fragment. One shape from every source: the `type` is namespaced by the caller and never interpreted by the Framework, which keeps no taxonomy of where Events come from and does not dedupe repeated deliveries. Not a Primitive of its own.
_Avoid_: trigger (for the input), message, notification, job

**Subscriber**:
A live client attached to a Thread, receiving its Events as they are appended. Attachment is state of the Thread itself rather than of any open request, so a Thread with Subscribers still costs nothing while idle. A Thread with no Subscriber routes completion and Approval Events to its Deliverer instead.
_Avoid_: listener, watcher, socket, connection (that is an MCP grant)

**Schedule**:
An Event a Thread will receive at a future time — once (`at`, `delay`) or repeatedly (`cron`). Belongs to the Thread it wakes; created by code through the Thread API, or by the Agent itself for its own Thread under the `scheduling` Capability. A firing is an ordinary Turn input and follows the one-Turn-at-a-time rule; a recurring Schedule holds at most one undelivered firing. The only public face of the Framework's timer — Step watchdogs and parked-Turn timeouts ride the same alarm but are not Schedules.
`thread.schedule({ at | delay | cron, tz?, input })` returns `{ scheduleId, nextAt }`; `cancelSchedule` and `schedules()` complete the API, and `status().nextScheduleAt` reports the soonest. Exactly one timing is given; `tz` is IANA and belongs to `cron` only. A firing is `send()` of the Event, so it coalesces into the next Turn while one runs or is parked; a cron whose last firing is still queued drops the tick as `schedule.skipped`, a one-shot is deleted on delivery, and a failed Turn is not retried. `schedule.created / fired / skipped / cancelled` record every step. Deployment caps: 100 pending per Thread, a year of horizon. The `scheduling { maxPending, maxHorizonMs, cron }` Capability (Scope ceiling as maximum) gives the Agent `schedule`, `cancel_schedule` and `list_schedules` for its own Thread only; its firings are `Event { type: "schedule.fired", payload }`, and a Policy rule naming `schedule` may `ask`. External triggers (`scheduled()`, `queue()`) stay Platform code over the Thread API.
_Avoid_: job, cron job, timer, alarm (for the public thing), reminder (as the concept)

**Connection**:
A named, typed credential grant a Tool acts through, held at one of two levels: agent-level (Scope, Agent, name) — shared by every User of that Agent, set through `scope.agents.connections` — or user-level (Scope, User, name) — granted by the User so the Agent acts on their behalf, usable across every Agent in the Scope, set through `scope.users.connections`. A Tool requires a Connection by name; user-level resolves before agent-level, and a user-level need on a user-less Thread is an `isError connection.unavailable` result, never a pause. An MCP server declares its level in ScopeConfig (`auth: none | static | oauth { level }`); an OAuth grant is the Connection `mcp:<serverId>`, held per holder (`agent:<id>` or `user:<id>`) in ScopeConfig, whose refresh token never leaves it and which alone talks to the authorization server. A call with no grant surfaces as an `approval.requested { kind: "connect", authUrl }` pause; completing OAuth at that URL (or `scope.mcp.authorize` from a settings page) lands on the one fixed callback route, which stores the tokens and wakes the Thread, and the call retries once. A refused token is refreshed once in place; a `403 insufficient_scope` steps up with the union of scopes. `scope.mcp.disconnect` drops the grant.
_Avoid_: credential, integration, token, secret (for the grant itself)

**MCP server**:
A remote Model Context Protocol server registered in ScopeConfig under `mcp.servers.<id>` (the Deployment defaults may register some for every Scope): its URL (checked by the SSRF guard at registration), `auth: none | static | oauth` (static headers as credential references; OAuth with its `level`, optional `scope` and an optional pre-registered `client { id, secret }`), allow/deny lists of its tool names, whether its annotations are trusted for gating, a catalogue `ttlMs` for servers that send no freshness hint, and `execution: harness | provider` — the provider's own MCP connector, Anthropic only, still fed the registry's token and lists. A Spec references it as `mcp:<id>` (every allowed tool) or `mcp:<id>/<tool>`; its tools reach the model as `id__tool`, grouped by server in id order after the Catalogue Tools.
_Avoid_: MCP connection, integration, plugin, connector

**Client identity**:
How a Deployment identifies itself to MCP authorization servers, from `createKarmi({ oauth: { origin, clientName } })`: a Client ID Metadata Document at `/.well-known/karmi-mcp-client.json` (its own URL as `client_id`, `none` auth, the one exact callback `redirect_uri`), used wherever a server advertises support; a pre-registered `client { id, secret }` on the server config, resolved per Scope, wins over it; Dynamic Client Registration (`application_type: web`, an issued secret kept in the SecretsProvider per issuer) is the fallback. An issuer that takes none of these is a `PreRegistrationRequired` config error naming the vendor's registration page. karmi ships no OAuth apps or secrets of its own. `karmi.oauth.handle(request)` serves both routes.
_Avoid_: OAuth app, client credentials (for the document), registration (for the identity)

**Catalogue cache**:
The `tools/list` of one MCP server, stored in ScopeConfig per (server, credential partition) with its `catalogVersion` (a digest of the ordered definitions), `ttlMs`, `cacheScope` and the server's protocol era. The partition is the grant holder for an OAuth server and `scope` otherwise; a partition with nothing cached may read another holder's `public` catalogue, so a Turn without a grant still offers the tools whose call will ask for consent. Refreshed at Turn start when stale, after a `-32602` from a call, or by `scope.mcp.refreshCatalog()`; never polled in the background. A server that cannot be reached serves its stale catalogue. `turn.started { toolsVersion }` digests the Catalogue fingerprint with every server's `catalogVersion`, so the model's tool prefix changes only when a catalogue does.
_Avoid_: tool cache, discovery cache, registry (for the cache)

**Prompt**:
An Agent's instructions, composed from ordered Fragments evaluated at the start of every turn. Never a static string, never persisted.
_Avoid_: system prompt (as the definition), template, instructions (for the whole)

**Fragment**:
A named, reusable piece of a Prompt: a function of the turn's context (model, Scope, User, Thread, available Tools, time) returning text or nothing. Agent base instructions, model-specific variants, Tool usage instructions and per-User context are all Fragments.
_Avoid_: section, snippet, partial, context provider

**Skill**:
A named procedure an Agent can load on demand: a description the model always sees, a body Fragment that enters context only when invoked (by the model through the built-in `use_skill`, by a User command naming it on a Turn input, or both), and optional Tools that exist only while it is active. Activation is a load point (`tools.loaded`), so a Skill stays active until a Compaction drops it. Attached to an Agent by reference, defined in code.
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
A Harness Step that shrinks a Thread's model context when `contextTokens > window - reserveTokens` (the last usage plus a cheap estimate, never re-tokenised), checked before every fresh model Step and after a `context_window_exceeded` stop: walk back to a Turn boundary keeping `keepRecentTokens` (a tool Step boundary when that Turn still overflows), summarise everything before it, and append a `thread.compacted { trigger, firstKeptSeq, tokensBefore, tokensAfter, strategy, summary, attachments }` event. The log is never rewritten; the next context is Prompt + summary + events from `firstKeptSeq`. Summarising is client-side by default or delegated to the provider (Anthropic's `compaction` block) by Provider profile; `before-compact` / `after-compact` Hooks wrap it either way, and `thread.compact()` asks for one.
_Avoid_: summarisation (for the Step), truncation, pruning, context reset

**Fork**:
A new Thread for the same Agent and User seeded with another Thread's log up to a `seq` by row copy (`thread.fork(seq)`); no tree is kept, and media stays with the original Thread, read by reference.
_Avoid_: branch (for the Thread), clone, copy (for the operation)

**Spill**:
The Harness rule that every tool result over the Agent's `context.toolOutput` limit is stored whole in R2 under the Thread as a `MediaRef` and shown to the model as head + tail + a truncation marker; the built-in `read_output` Tool re-reads it by ref. Always on, not a Capability.
_Avoid_: overflow, artifact (for spilled output), truncation (for the storage)

**MediaRef**:
The reference by which binary content travels through karmi: `{ id, key, mimeType, bytes, name? }` pointing at an R2 object under `{scope}/media/{threadId}/`, minted only by the Framework (`uploads.put()`, a Tool's `ctx.media.put()`, or the Harness spilling model/Tool-produced bytes at ingress) with the MIME type sniffed and the size measured. Bytes never enter the event log — events carry the ref; provider adapters re-inline base64 at request-build per the model's capabilities, and Channels read via short-lived presigned URLs from `karmi.media.url(ref)`. Media lives and dies with its Thread; a ref whose object is gone degrades to a text placeholder, never a failed Turn.
_Avoid_: attachment (for the ref), file handle, URL (for the ref), blob

**Holder**:
Whose OAuth grant an MCP server call runs under: the Agent (`agent:<id>`) for an agent-level server, or the User (`user:<id>`) for a user-level one. A user-level server on a user-less Thread has no holder, so no grant can ever resolve for it. Grants and private Catalogue caches are keyed by holder.
_Avoid_: principal, owner, subject

**Partition**:
The slice of a Catalogue cache one set of credentials sees: the holder for an OAuth server, or the single `scope` partition for a server with static or no auth. A server may mark its list `public`, in which case a partition with nothing cached reads another holder's copy.
_Avoid_: namespace, bucket, shard

**Step-up**:
A second consent flow for an MCP server that answered `403 insufficient_scope`, requesting the union of the scopes already granted and the scopes the server challenged with.
_Avoid_: re-auth, scope escalation

**Era**:
Which MCP protocol revision a server speaks: the 2026-07-28 stateless Streamable HTTP form or the 2025 form with `initialize` and `Mcp-Session-Id`. Stored with the Catalogue cache so the next connect adopts it without probing.
_Avoid_: protocol version (in code), mode

**Deferred Tool**:
A Tool the Agent may call but whose definition is kept out of the model's context until loaded: the model sees only its name in an index and loads it through the always-present `tool_search` built-in. Which Tools defer is a `context.tools` setting on the Agent Spec (`auto` — defer all deferrable Tools once their definitions exceed a share of the window — `always`, or `never`), with per-reference `alwaysLoad` pins; Framework built-ins and Skill Tools never defer. A load is a `tools.loaded` Thread event, so loaded Tools persist across Turns until Compaction drops them. Permission Policy applies to the whole Tool set before deferral: denied Tools are never indexed, `ask` Tools pause at call time as usual.
_Avoid_: lazy tool, hidden tool, tool search (for the Tool itself), dynamic tools

**Load point**:
A `tools.loaded` event in the Thread log. From that event on, the deferred Tools it names (or the Skill it activates) are in the model's context, until a Compaction cuts the log before it. The loaded set of a Turn is the union of every load point since the last Compaction.
_Avoid_: activation event, tool load

**Deliverer**:
A Catalogue item — code, by name — that pushes a Thread's output to a Channel when no Subscriber is attached. Chosen per Thread from the last inbound input; invoked from a Queue, at-least-once.
_Avoid_: webhook, callback, notifier, sender

**Delegation**:
One Agent handing a task to another Agent in the same Scope and receiving its result. The parent's Agent Spec lists, by name, the Agents it may delegate to; nothing not listed is reachable. The child runs under its own Agent Spec, in its own Thread, with fresh context and the parent's User; the parent receives only the child's final reply. Gated by a Capability. There is no separate "sub-agent" kind of thing — only Agents and the act of delegating.
The `delegation` grant defaults to `maxDepth: 4`, `maxConcurrent: 8`, and `maxChildren: 32`, bounded by Scope ceilings. Each ancestor counts all descendants started during its Turn; completed children free concurrency, while the child count remains spent. `status().budget.delegated` reports `{ children, active }`. The first delegation fixes a wall deadline from the parent's remaining budget; parking and child approvals do not extend it.

Child ids are `{parentThreadId}/{encoded callId}`, using the stable `ToolContext.callId` so repeated model tool-call ids on later Turns create distinct children. `parent { threadKey, callId }` appears in status and index records; `scope.threads.list({ agent, parent })` filters by parent key, with `parent: null` selecting roots. `delegation.started/completed` name the child with `childKey`. Approval events and pending approvals carry `child { threadId, seq }`; answers travel down to that Thread and remembered grants stay there.
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

**Test kit**:
The `@karmi/core/testing` export: `createTestKarmi()` plus the doubles it composes — `fakeProvider` (a scripted Provider profile whose requests are recorded), `Clock`, `LocalProcessSandbox`, the brute-force `VectorStore`, an in-memory `SecretsProvider`, `fakeMcpServer` — and the event-log matchers and Provider record/replay. Every double is a real implementation of a real seam; core has no test-only behaviour. Tests run the real Thread DO in workerd under `@cloudflare/vitest-plugin`; there is no Node-only harness.
_Avoid_: mocks (for the doubles), test harness, test utils

**Scoped fetch**:
The one egress seam: a `fetch` built per Turn from the resolved Scope config and handed to every outbound caller — Provider adapters, MCP transports, OAuth discovery. It rejects private and reserved addresses (vendored SSRF guard), hosts outside its allow-list (derived from the Provider profile's gateway or `baseUrl`, or the registered MCP servers) with a synthetic 403, forces manual redirects, and stamps nothing outbound. Gateway headers belong to the adapter, not to it.
_Avoid_: outbound worker, proxy, egress hook (for this), fetch wrapper (as the concept)

**Clock**:
The single injectable time source `@karmi/core` reads for everything time-driven — watchdog, park timeouts, Approval timeouts, Schedules and cron. The interface is `Clock.now()` (epoch milliseconds), injected with `createKarmi({ clock })` and defaulting to wall time. In the Test kit, `clock.advance(milliseconds | "24h")` moves it and fires due Durable Object alarms, so recovery, parking and scheduling are testable without waiting.
_Avoid_: timer, fake timers, `Date.now()`
