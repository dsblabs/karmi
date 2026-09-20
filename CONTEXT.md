# karmi

karmi is a code-first TypeScript framework. You use it to build agent harnesses that run natively on a serverless runtime. An agent _platform_ is a later product that a developer builds with karmi. It is not part of karmi.

## Language

**Framework**:
The Framework is karmi. It is the code-first library that a developer uses to define and deploy agents on a serverless runtime.
_Avoid_: platform, SDK (when referring to karmi as a whole)

**Platform**:
A Platform is a product that a developer builds with the Framework. The users of the Platform run agents in it. The Platform owns tenants, sign-up and billing. It is out of the scope of karmi.
_Avoid_: framework, app

**Harness**:
The Harness is the runtime code that drives a model in a loop. It handles tool calls, streaming, context management and permissions. Claude Code, Codex and pi do the same work on a local machine.
_Avoid_: agent runner, executor

**Primitive**:
A Primitive is a first-class building block that the Framework gives above the Harness. The v0 set has these Primitives:

- Agent, which comes from an Agent Spec
- Tool
- Prompt and Fragment
- Skill
- Thread
- User
- Connection
- Memory
- Knowledge and Retriever
- Capability
- Hook
- Permission Policy

Scope is the key for all of them.
_Avoid_: component, module, feature

**Channel**:
A Channel is an external surface through which a person or an event reaches a session. Examples are a chat UI, a chat app, inbound email and a webhook. Channel integrations are outside karmi.
_Avoid_: integration, connector, frontend

**Deliverer**:
A Deliverer is a Catalogue item. It is code with a name. It pushes the output of a Thread to a Channel when no Subscriber is attached. The last Turn input selects it for the Thread with `channelRef.deliverer { name, ref }`. The Queue invokes it at least once with completion and Approval Events, at the granularity that the Deliverer selects.
_Avoid_: webhook, callback, notifier, sender, notification service, Channel integration

**Capability**:
A Capability is a gated ability that an Agent Spec can grant to an Agent. These are examples:

- To run small generated scripts.
- Outbound HTTP.
- Remote MCP.
- Long-running turns (`longRunning`, with Step, wall-clock and token budgets).
- To delegate to other Agents.
- To schedule its own future wake-ups.

The Catalogue implements the Capability. The Spec switches it on. The Framework merges a Scope-level ceiling as a maximum. A Spec that asks for more than the ceiling is a validation error. An Agent cannot reach an ability that the Spec does not grant.
_Avoid_: permission, feature flag

**Script**:
A Script is code that the model writes. It runs under the `scripts` Capability through the built-in `run_script` Tool. One `Sandbox` seam has two tiers:

- `isolate` (v0) runs JS in a Dynamic Worker with no filesystem, egress, secrets or storage. Its only API is the allow-resolved Tools of the Agent. Each call goes through the Harness gate again.
- `container` runs shell or Python in a Sandbox SDK container. It has a Workspace and allow-listed egress. It has no Tool bridge.

Nested Tool calls are child Thread events. They are not model context. Files come back as `artifacts: MediaRef[]`. If a container Script still runs at `wallMs`, the Harness promotes it to a Job. A Script can reach every allow-resolved Tool, also a Tool that the model did not load. The deferred loaded set gates only the calls of the model.
_Avoid_: code execution, bash tool, sandbox (for the script itself), function calling

**Workspace**:
A Workspace is the disk of a container-tier Script. Each Thread has one container. The first `run_script` of a Turn creates it. The end of the Turn destroys it. It is also destroyed after `idleMs` of idle time, after a cancel and after a Thread destroy. A Workspace is an ephemeral cache. It is never the durable source of truth. The Framework fills `/in` from the `MediaRef`s that a call names. When the Script finishes, the Framework exports `/out` to R2 as artifacts. All other files can disappear at any time.
_Avoid_: session filesystem, virtual filesystem, persistent volume

**Tool**:
A Tool is a named action that an Agent can call. It has these parts:

- A JSON-Schema input.
- Annotations, for example read-only and destructive.
- Optional usage instructions as a Fragment.
- An optional required Connection.
- The code that executes it.

A Tool comes from one of three sources. The Catalogue supplies it as code. A remote MCP server supplies it at runtime with the name `server__tool`. The Framework supplies it as a built-in. An Agent Spec sees the same shape from each source.
_Avoid_: function, action, integration, capability

**Provider Tool**:
A Provider Tool is a Tool that the provider of the model executes inside its own turn. The Harness never executes it. Examples are web search, web fetch and provider-side code execution. The `providerTools` Capability grants it by an abstract name. The provider adapter maps the name to the native definition. Policy can only include it in the request or exclude it from the request. Policy can never use `ask`. The Harness logs its call and its byte-exact result as `server_tool` events. These events are different from Harness Tool events.
_Avoid_: server tool, hosted tool, built-in tool, native tool

**Permission Policy**:
A Permission Policy is data in an Agent Spec. It is an ordered list of rules that match Tools by name and annotation. Each rule resolves to allow, ask or deny. Ask stops the Turn until a person answers. The Scope config and the Deployment defaults have their own rules. The Framework resolves one policy for each Agent. It reads the rules of the Scope first, then the rules of the Deployment, then the rules of the Spec.
_Avoid_: permission rules, ACL, guardrails

**Hook**:
A Hook is a Catalogue item. It is code that runs at a lifecycle point, for example before a tool call, after a turn or on an error. An Agent Spec attaches a Hook to an Agent by name.
_Avoid_: middleware, plugin, interceptor, callback

**Scope**:
A Scope is the isolation key. Every Primitive, secret and config value resolves under a Scope. An opaque string identifies the Scope. The Platform makes the string, and the Framework never interprets it. Nothing in one Scope can see a different Scope. The Framework has no operation that crosses Scopes. A Scope is active, suspended, destroying or destroyed. You can reverse a suspension. A destruction reserves the identity of the Scope permanently. The Platform decides what a Scope represents, for example a tenant, a user or a workspace. The Platform keeps the list of Scopes.
_Avoid_: tenant, organisation, account, workspace

**Destroy walk**:
The Destroy walk is the maintenance job that remains after `scope.destroy()`. The Framework writes the tombstone immediately. Then the walk runs on the ScopeConfig alarm in idempotent batches. The batches do this work:

- They revoke external credentials.
- They remove Threads, which include Delegation children.
- They remove Memories.
- They remove Knowledge corpora and their Retriever mirrors.
- They remove the `{scope}/` R2 prefix.
- Last, they remove the tables of the Scope.

The walk stops when only the tombstone and the operation row remain. `scope.destroyStatus(operationId)` reports the phase and the counts. It also reports each revocation that the walk requested from a Secrets provider that karmi does not own.
_Avoid_: cleanup job, garbage collection, purge

**Deployment**:
A Deployment is one installation of the Framework. It is a Worker with its Catalogue and its deployment-wide defaults: providers, ceilings and policy. Every Scope inherits the defaults. A Scope can only make them stricter.
_Avoid_: environment, instance, app

**Provider credential**:
A Provider credential is a secret that authorises model-provider calls for one Scope. A Provider profile refers to it in one of two forms:

- `scope:<name>` for a credential that the Scope owns. The Platform puts it write-only through `scope.credentials`.
- `deployment:<name>` for a credential that the Deployment owns. It comes from `createKarmi({ credentials })`.

The Platform is the authority for the credential. The Framework keeps it in the default envelope store, or resolves it from a Secrets provider that the Platform supplies. The credential is never part of an Agent Spec, a config revision, an event or a Turn snapshot. The Framework resolves it immediately before each model Step. The Framework discards it after it builds the request. Thus a revocation applies at the next Step.
_Avoid_: API key, BYOK key, provider config, Connection

**Secrets provider**:
A Secrets provider is the seam through which a Provider credential resolves. `resolve(ref)` returns a Sensitive value. `describe(ref)` returns metadata. `put`, `revoke`, `rewrap` and `list` are optional. The default Secrets provider is the envelope store:

- Each credential has one data key.
- The active key of a versioned Deployment key ring (`KARMI_KEYRING`) wraps the data key.
- The rows are in the ScopeConfig of the Scope.
- The encryption binds the ciphertext to the deployment, the Scope, the name and the version.

The Secrets provider of the Test kit is in-memory.
_Avoid_: vault, key store, secret manager (for the seam)

**Sensitive value**:
A Sensitive value is the only form in which a credential moves inside the Framework. It is a wrapper. The wrapper refuses JSON, string coercion and inspection. It loses its value under structured clone. It gives its value only through `expose()` in the request builder of a Provider adapter. Loggers redact it.
_Avoid_: secret string, credential value, token (for the wrapper)

**Credential fallback**:
A Credential fallback is an opt-in of a Provider profile. With it, the Provider profile runs under a named Deployment profile and not under its own profile. The fallback applies when the credential is `missing`, which is the default reason. It also applies when a call fails with `auth`, `quota`, `rate_limit` or `unavailable`. The Framework decides `missing` at the start of each Step. A Provider error starts the fallback for the remainder of the Turn. The Harness first tries the same model again. `step.started` records each fallback with its reason, the credential source and the credential version.
_Avoid_: key rotation (for this), retry, model fallback (that is `model.fallbacks`)

**Provider profile**:
A Provider profile is a named provider account that a Scope can use. It combines an adapter, gateway settings, model compatibility and a reference to a Provider credential. The Scope or the Deployment owns that credential. An Agent selects a profile by name. A Spec that names no profile runs under `default` when the Scope has one. If not, it runs under the only profile of the Scope. `default` is a conventional name. It is never a fallback for a profile that does not exist.
_Avoid_: provider, account, API-key config, credential

**User**:
A User is the principal that an Agent acts for or with. The User is the person who chats, or the person whose events the Agent processes. A User has a key under a Scope, and a Scope has many Users. The things of one User are under (Scope, User): the profile, memory, history and user-level Connections. The caller maps channel identities to a User before the Framework sees them. The Framework never authenticates.
_Avoid_: end user, customer, principal, account

**Thread**:
A Thread is one durable conversation between one Agent and one User. Its key is (Scope, Agent, User, threadId). An Event without a User can have a Thread with no User. Turn inputs drive the Thread. A Turn input is a User message or an Event. The Thread holds the transcript. You can resume or fork a Thread. A Thread that a Delegation opens is a child of the Thread that delegates. The child acts for the same User. The Channel binding decides if a User gets one Thread or many Threads with an Agent. The Agent does not decide this. The chat history of a User with an Agent is the set of their Threads with that Agent.
_Avoid_: session, conversation, chat, channel

**Turn**:
A Turn is one run of the Harness loop on a Thread. It goes from a Turn input to `turn.completed` or `turn.failed`. The Durable Object of the Thread drives the full Turn as a sequence of Steps. The source of the trigger makes no difference. A connected client only subscribes. A Thread runs one Turn at a time. A Turn can be parked while it waits for an approval, a scheduled wait, a budget `continue` or a Job. A parked Turn continues to hold the Thread.
_Avoid_: request, run, session, invocation

**Park**:
Park is the state of a Turn that stopped to wait and continues to hold its Thread. The Turn waits for an Approval, a Job, a budget `continue`, an OAuth consent or a suspended Scope. When the answer arrives, the parked Turn resumes from its log. A parked Turn is not running and it is not finished.
_Avoid_: pause (for the state), suspend (that is a Scope), block

**Tombstone**:
A Tombstone is the row that a destroyed Thread, Agent or Scope leaves. It makes sure that nothing uses the identity again. An item with a Tombstone refuses every operation except the lifecycle reads that report on it. The durable cleanup runs later in scheduler batches.
_Avoid_: soft delete, deleted flag

**Step**:
A Step is the unit of a Turn that the Harness persists and recovers at a boundary. There are two types:

- A model Step is one streamed model call.
- A tool Step is one tool batch. A batch is a set of parallel read-only Tools or one Tool that mutates.

At a boundary, the event log is the only state. After an eviction, the Step that did not finish runs again. A tool Step that was partly done runs again only the Tools that have no persisted result. Of those Tools, it runs only the Tools with a read-only or idempotent annotation. Each other call that did not finish gets an interrupted result from the Harness: `isError` and `interrupted: { attempt }`. This result tells the model that the action possibly occurred and possibly did not. The Harness never runs such a call a second time. The Harness starts Steps in-process. The DO alarm is a watchdog. It does not drive the Steps.
_Avoid_: iteration, tick, workflow step, phase

**Job**:
A Job is durable work that continues after one Durable Object invocation and runs outside the Thread. Examples are a container-tier Script, a slow remote Tool and bulk Knowledge ingestion. A Tool starts a Job when it returns `{ pending: jobId }`. This return parks the tool Step. Progress and completion come back into the Thread as Events that carry `MediaRef`s. The interface is v0. A Cloudflare Workflow implementation waits until a Tool needs it.
_Avoid_: workflow, task, background task, async tool

**Event**:
An Event is a Turn input that is not a chat message. It is a typed JSON payload from a webhook, a queue, a fleet cron or a Schedule. It is about one User or about no User. The code of the caller, or the Schedule of the Thread, delivers it into a Thread. A Fragment shows it to the Agent. Every source uses one shape. The caller puts a namespace in the `type`, and the Framework never interprets it. The Framework keeps no taxonomy of Event sources. It does not remove repeated deliveries. An Event is not a Primitive.
_Avoid_: trigger (for the input), message, notification, job

**Subscriber**:
A Subscriber is a live client that is attached to a Thread. It receives the Events of the Thread as the Thread appends them. The attachment is state of the Thread and not of an open request. Thus an idle Thread with Subscribers has no cost. A Thread with no Subscriber sends completion and Approval Events to its Deliverer.
_Avoid_: listener, watcher, socket, connection (that is an MCP grant)

**Schedule**:
A Schedule is an Event that a Thread will receive at a future time. It fires one time (`at`, `delay`) or many times (`cron`). It belongs to the Thread that it wakes. Code creates it through the Thread API. The Agent can also create it for its own Thread under the `scheduling` Capability. A firing is an ordinary Turn input and obeys the rule of one Turn at a time. A recurring Schedule holds a maximum of one firing that is not delivered. A Schedule is the only public part of the timer of the Framework. Step watchdogs and parked-Turn timeouts use the same alarm, but they are not Schedules.

The API has these parts:

- `thread.schedule({ at | delay | cron, tz?, input })` returns `{ scheduleId, nextAt }`.
- `cancelSchedule` and `schedules()` complete the API.
- `status().nextScheduleAt` reports the time of the firing that comes first.

Give exactly one timing. `tz` is an IANA name and applies only to `cron`. A firing is a `send()` of the Event. Thus it joins the next Turn while a Turn runs or is parked. If the last firing of a cron still waits for delivery, the Framework drops the tick as `schedule.skipped`. The Framework deletes a one-shot Schedule on delivery. The Framework does not try a failed Turn again. The events `schedule.created`, `schedule.fired`, `schedule.skipped` and `schedule.cancelled` record each step. The Deployment caps are 100 pending Schedules for each Thread and a horizon of one year.

The `scheduling { maxPending, maxHorizonMs, cron }` Capability uses the Scope ceiling as a maximum. It gives the Agent `schedule`, `cancel_schedule` and `list_schedules` for its own Thread only. Its firings are `Event { type: "schedule.fired", payload }`. A Policy rule that names `schedule` can use `ask`. External triggers (`scheduled()`, `queue()`) stay Platform code that uses the Thread API.
_Avoid_: job, cron job, timer, alarm (for the public thing), reminder (as the concept)

**Alarm**:
An Alarm is one timed entry that the Framework keeps for a Durable Object. It is a Step watchdog, a parked-Turn timeout, a Schedule firing or a cleanup batch. An Alarm is internal to the Framework and is never part of the public API. A Schedule is the only public thing that produces an Alarm. An Alarm is not a Job. A Job is work that runs outside the Thread. An Alarm only tells when the Durable Object must wake next, and why.
_Avoid_: job, scheduled job, task, timer

**Connection**:
A Connection is a named, typed credential grant that a Tool acts through. It is at one of two levels:

- Agent-level, with the key (Scope, Agent, name). Every User of that Agent shares it. Set it through `scope.agents.connections`.
- User-level, with the key (Scope, User, name). The User grants it, and the Agent then acts for the User. Every Agent in the Scope can use it. Set it through `scope.users.connections`.

A Tool requires a Connection by name. The user-level resolves before the agent-level. A user-level need on a Thread with no User is an `isError connection.unavailable` result. It is never a pause.

An MCP server declares its level in ScopeConfig (`auth: none | static | oauth { level }`). An OAuth grant is the Connection `mcp:<serverId>`. ScopeConfig holds it for each holder (`agent:<id>` or `user:<id>`). The refresh token never leaves ScopeConfig. Only ScopeConfig talks to the authorization server.

A call with no grant shows as an `approval.requested { kind: "connect", authUrl }` pause. A person completes OAuth at that URL, or a settings page calls `scope.mcp.authorize`. The two flows end on the one fixed callback route. That route stores the tokens and wakes the Thread. Then the call runs again one time. The Framework refreshes a refused token one time in place. After a `403 insufficient_scope`, it does a Step-up with the union of the scopes. `scope.mcp.disconnect` removes the grant.
_Avoid_: credential, integration, token, secret (for the grant itself)

**MCP server**:
An MCP server is a remote Model Context Protocol server. ScopeConfig registers it under `mcp.servers.<id>`. The Deployment defaults can register servers for every Scope. The registration has these parts:

- The URL. The SSRF guard checks it at registration.
- `auth: none | static | oauth`. Static headers are credential references. OAuth has its `level`, an optional `scope` and an optional pre-registered `client { id, secret }`.
- The allow list and the deny list of its tool names.
- A flag that tells if the Harness trusts its annotations for gating.
- A catalogue `ttlMs` for a server that sends no freshness hint.
- `execution: harness | provider`. The `provider` value uses the MCP connector of the provider, which only Anthropic has. The connector continues to get the token and the lists of the registry.

A Spec refers to the server as `mcp:<id>` for every allowed tool, or as `mcp:<id>/<tool>` for one tool. Its tools reach the model as `id__tool`. They come after the Catalogue Tools, in groups for each server, in id order.
_Avoid_: MCP connection, integration, plugin, connector

**Client identity**:
Client identity is the method by which a Deployment identifies itself to MCP authorization servers. It comes from `createKarmi({ oauth: { origin, clientName } })`. There are three methods, in this order of precedence:

1. A pre-registered `client { id, secret }` on the server config. The Framework resolves it for each Scope.
2. A Client ID Metadata Document at `/.well-known/karmi-mcp-client.json`. It has its own URL as `client_id`, `none` auth and the one exact callback `redirect_uri`. The Framework uses it where a server advertises support.
3. Dynamic Client Registration with `application_type: web`. The SecretsProvider keeps the issued secret for each issuer.

An issuer that accepts none of these methods is a `PreRegistrationRequired` config error. The error names the registration page of the vendor. karmi supplies no OAuth apps or secrets of its own. `karmi.oauth.handle(request)` serves the two routes.
_Avoid_: OAuth app, client credentials (for the document), registration (for the identity)

**Catalogue cache**:
A Catalogue cache is the `tools/list` of one MCP server. ScopeConfig stores it for each (server, credential partition). The stored record has the `catalogVersion`, the `ttlMs`, the `cacheScope` and the protocol era of the server. The `catalogVersion` is a digest of the ordered definitions. The partition is the grant holder for an OAuth server and `scope` for other servers. A partition with an empty cache can read the `public` catalogue of a different holder. Thus a Turn without a grant still offers the tools, and a call to one of them asks for consent.

The Framework refreshes the cache in three cases:

- At the start of a Turn, when the cache is stale.
- After a call returns `-32602`.
- When code calls `scope.mcp.refreshCatalog()`.

The Framework never polls in the background. When the Framework cannot reach a server, it uses the stale catalogue of that server. `turn.started { toolsVersion }` is a digest of the Catalogue fingerprint and the `catalogVersion` of every server. Thus the tool prefix of the model changes only when a catalogue changes.
_Avoid_: tool cache, discovery cache, registry (for the cache)

**Prompt**:
A Prompt is the instructions of an Agent. The Framework composes it from ordered Fragments and evaluates them at the start of every turn. A Prompt is never a static string. The Framework never persists it.
_Avoid_: system prompt (as the definition), template, instructions (for the whole)

**Fragment**:
A Fragment is a named, reusable piece of a Prompt. It is a function of the context of the turn that returns text or nothing. The context has the model, the Scope, the User, the Thread, the available Tools and the time. Agent base instructions, model-specific variants, Tool usage instructions and per-User context are all Fragments.
_Avoid_: section, snippet, partial, context provider

**Skill**:
A Skill is a named procedure that an Agent can load when it needs it. It has these parts:

- A description that the model always sees.
- A body Fragment that enters the context only when something invokes the Skill.
- Optional Tools that exist only while the Skill is active.

The model invokes a Skill through the built-in `use_skill`. A User command that names the Skill on a Turn input also invokes it. A Skill can permit one method or the two methods. Activation is a Load point (`tools.loaded`). Thus a Skill stays active until a Compaction drops it. Code defines a Skill. An Agent Spec attaches it to an Agent by reference.
_Avoid_: command, slash command, plugin, playbook

**Memory**:
Memory is the information that Agents collect about a User across Threads. Its key is (Scope, User), and every Agent in the Scope shares it. It has a structured Profile with fields that the developer defines, and free-form Notes. It reaches the model through a Fragment and the `remember` and `recall` Tools. Data that the Platform already has about a User, such as orders or CRM data, is not Memory. A Fragment injects that data.
_Avoid_: long-term memory, user data, history, knowledge

**Knowledge**:
Knowledge is a named corpus of documents from which an Agent answers. Its key is (Scope, name). It is the same for every User. An Agent Spec attaches it to an Agent by reference. Ingestion is in bulk, and a Retriever searches it. It reaches the model as a Fragment that has the full corpus, for a small corpus, or as a search Tool.
_Avoid_: knowledge base, KB, RAG, memory, documents (for the corpus)

**Retriever**:
A Retriever is the strategy for a Knowledge search or a Memory recall. It gets a query and returns ranked passages. It is a Catalogue item. The default is full-text search, which uses FTS5 in the SQLite of the Knowledge. Vector similarity and hybrid search use the same seam. Hybrid search fuses the ranks of BM25 and vector search. The Framework owns the authoritative Knowledge ledger, the chunking and the embedding call. A custom Retriever can keep only external state that it can build again. It never reads or writes the ledger directly. A Vector store is only the mirror to which the vector Retriever writes.
_Avoid_: vector store (for the strategy), index, embeddings (for the strategy), RAG

**Vector store**:
A Vector store is the place where a vector Retriever keeps embeddings, with Scope as the key. There are two stores:

- The SQLite of the Knowledge, with brute-force search. It is the default and the only store that tests need.
- Cloudflare Vectorize, with one index for each Deployment and embedding model, and the Scope as the namespace.

The chunk ledger of the Knowledge is the source of truth. The store is a mirror. The Framework builds it again or empties it from the ledger, and does not change the opaque vector IDs of the Framework. The embedding model, the dimensions and the metric are facts of the Knowledge. The first ingest fixes them.
_Avoid_: index (for the store), database, Vectorize (as the generic term)

**Agent**:
An Agent is a configured actor that the Framework runs. The Framework creates it from an Agent Spec. Its key is (Scope, agentId). A Scope can hold any number of Agents. The Platform creates them at runtime, or a developer writes them in code. The shape is the same in the two cases.
_Avoid_: bot, assistant, persona, agent definition (for the running thing)

**Agent Spec**:
An Agent Spec is the plain-data description from which the Framework creates an Agent. A caller-chosen `agentId` under a Scope identifies it. It has these parts:

- A name.
- Ordered Prompt entries, with per-model variants.
- The model choice.
- References by name to Catalogue items: Tools, Skills, Knowledge, Retrievers and Hooks. Each reference can have settings.
- Connection declarations, which never contain credentials.
- Capability grants.
- A Memory profile schema.
- A Permission Policy.

An Agent Spec contains no code. The Framework validates it against the Scope that stores it, and reports errors and warnings. A stored Spec has a version that the Framework makes. A Turn uses one snapshot of the Spec from start to finish.
_Avoid_: config, definition file, manifest, template

**Prompt entry**:
A Prompt entry is one item in the ordered instructions of an Agent Spec. It is literal text, or a Catalogue Fragment by name with arguments. You can limit an entry to matching models. Every entry becomes a Fragment when the Framework evaluates the Prompt.
_Avoid_: prompt section, variant (for the entry), template

**Catalogue**:
The Catalogue is everything that a developer defines in code and deploys with the Framework. Agent Specs refer to its items by name. The items are Tools, Fragments, Skills, Retrievers, Hooks, Deliverers and code-defined Agents. Items are pure definitions, and the developer assembles them explicitly at boot. A name is unique in its kind. Every Scope shares the Catalogue. It is the only place that holds behaviour code. The Framework can describe the Catalogue as data, and a Platform can build its editors from that data.
_Avoid_: registry, library, plugins, toolbox

**Channel binding**:
A Channel binding is developer code in the Worker of the Framework user. It adapts one Channel to a Thread. It does these tasks:

- It maps external identities to (Scope, User).
- It selects the `threadId`.
- It uploads media.
- It calls `thread.send()`.
- It registers a Deliverer for replies.

A Channel binding is outside karmi. It talks only to the Thread API.
_Avoid_: integration, adapter, connector, plugin

**Turn input**:
A Turn input is the thing that drives one turn of a Thread. It is a User message, which has text and media Parts, or an Event. It carries an opaque `channelRef`. The Channel binding uses the `channelRef` to reply in the same place.
_Avoid_: request, prompt, payload

**Thread event**:
A Thread event is one entry in the ordered, persisted event log of a Thread. Each entry has a `seq` number. The log has these entries:

- Turn start and end.
- Step start and end.
- Turn paused and resumed.
- Streamed deltas.
- Completed parts.
- Tool calls and results.
- Approval requests.
- Job progress.
- Compaction.

The Thread event is the one outbound shape. The Framework derives the transcript from the log, and clients replay from a `seq`.
_Avoid_: message (for the log entry), stream chunk, notification

**Compaction**:
Compaction is a Harness Step that makes the model context of a Thread smaller. It runs when `contextTokens > window - reserveTokens`. `contextTokens` is the last usage plus a low-cost estimate. The Harness never counts the tokens again. The Harness makes the check before every fresh model Step and after a `context_window_exceeded` stop. The Step does these operations:

1. It goes back to a Turn boundary and keeps `keepRecentTokens`. If that Turn still overflows, it uses a tool Step boundary.
2. It summarises everything before the boundary.
3. It appends a `thread.compacted { trigger, firstKeptSeq, tokensBefore, tokensAfter, strategy, summary, attachments }` event.

The Harness never rewrites the log. The next context is the Prompt, the summary and the events from `firstKeptSeq`. By default the client side makes the summary. A Provider profile can delegate it to the provider, which is the `compaction` block of Anthropic. The `before-compact` and `after-compact` Hooks wrap the two methods. `thread.compact()` asks for a Compaction.
_Avoid_: summarisation (for the Step), truncation, pruning, context reset

**Fork**:
A Fork is a new Thread for the same Agent and User. `thread.fork(seq)` copies the rows of the log of a different Thread up to a `seq`. The Framework keeps no tree. It also copies the media to which the copied log refers. Thus the Fork owns its media, and it stays complete after the original Thread is gone.
_Avoid_: branch (for the Thread), clone, copy (for the operation)

**Spill**:
Spill is a Harness rule for a tool result that is larger than the `context.toolOutput` limit of the Agent. The Harness stores the full result in R2 under the Thread as a `MediaRef`. It shows the model the head, the tail and a truncation marker. The built-in `read_output` Tool reads the result again by its ref. Spill is always on. It is not a Capability.
_Avoid_: overflow, artifact (for spilled output), truncation (for the storage)

**MediaRef**:
A MediaRef is the reference by which binary content moves through karmi. Its shape is `{ id, key, mimeType, bytes, name? }`. It points at an R2 object under `{scope}/media/{threadId}/`. Only the Framework makes a MediaRef, in one of three ways:

- `uploads.put()`.
- `ctx.media.put()` of a Tool.
- The Harness, when it spills bytes from the model or a Tool at ingress.

The Framework finds the MIME type from the bytes and measures the size. Bytes never enter the event log. Events carry the ref. Provider adapters put base64 inline again when they build a request, as the capabilities of the model permit. Channels read through short-lived presigned URLs from `karmi.media.url(ref)`.

The Thread owns a ref after the Framework accepts a Turn input that carries it. From then on, the ref has the same life as that Thread. Before that, the bytes belong to the caller that asked for the ref. If that caller abandons an upload before acceptance, the caller discards it through `uploads.delete()`. When the object of a ref is gone, the ref becomes a text placeholder. It never causes a failed Turn.
_Avoid_: attachment (for the ref), file handle, URL (for the ref), blob

**Holder**:
A Holder is the owner of the OAuth grant under which an MCP server call runs. It is the Agent (`agent:<id>`) for an agent-level server, or the User (`user:<id>`) for a user-level server. A user-level server on a Thread with no User has no Holder. Thus no grant can resolve for it. The Holder is the key for grants and for private Catalogue caches.
_Avoid_: principal, owner, subject

**Partition**:
A Partition is the part of a Catalogue cache that one set of credentials sees. It is the Holder for an OAuth server. For a server with static auth or no auth, it is the one `scope` partition. A server can mark its list `public`. Then a partition with an empty cache reads the copy of a different Holder.
_Avoid_: namespace, bucket, shard

**Step-up**:
A Step-up is a second consent flow for an MCP server that answered `403 insufficient_scope`. It requests the union of the granted scopes and the scopes in the challenge of the server.
_Avoid_: re-auth, scope escalation

**Era**:
The Era is the MCP protocol revision that a server uses. It is the 2026-07-28 stateless Streamable HTTP form, or the 2025 form with `initialize` and `Mcp-Session-Id`. The Framework stores it with the Catalogue cache. Thus the next connect uses it and does not probe the server.
_Avoid_: protocol version (in code), mode

**Deferred Tool**:
A Deferred Tool is a Tool that the Agent can call. Its definition stays out of the model context until the model loads it. The model sees only its name in an index. The model loads it through the `tool_search` built-in, which is always present. The `context.tools` setting on the Agent Spec selects the Tools that defer:

- `auto` defers all deferrable Tools when their definitions use more than a set share of the window.
- `always`.
- `never`.

A reference can pin a Tool with `alwaysLoad`. Framework built-ins and Skill Tools never defer. A load is a `tools.loaded` Thread event. Thus loaded Tools stay across Turns until a Compaction drops them. The Permission Policy applies to the full Tool set before deferral. The index never has denied Tools. `ask` Tools pause at call time as usual.
_Avoid_: lazy tool, hidden tool, tool search (for the Tool itself), dynamic tools

**Load point**:
A Load point is a `tools.loaded` event in the Thread log. After that event, the Deferred Tools that it names, or the Skill that it activates, are in the model context. They stay there until a Compaction cuts the log before the event. The loaded set of a Turn is the union of every Load point after the last Compaction.
_Avoid_: activation event, tool load

**Delegation**:
Delegation is the act in which one Agent gives a task to a second Agent in the same Scope and receives its result. The Agent Spec of the parent lists by name the Agents to which it can delegate. It cannot reach an Agent that the list does not have. The child runs under its own Agent Spec, in its own Thread, with new context and the User of the parent. The parent receives only the final reply of the child. A Capability gates Delegation. There is no "sub-agent" kind. There are only Agents and the act of Delegation.

The `delegation` grant has the defaults `maxDepth: 4`, `maxConcurrent: 8` and `maxChildren: 32`. The Scope ceilings limit them. Each ancestor counts all descendants that start during its Turn. A completed child frees concurrency, but its child count stays spent. `status().budget.delegated` reports `{ children, active }`. The first delegation fixes a wall deadline from the remaining budget of the parent. Parking and child approvals do not extend the deadline.

A child id is `{parentThreadId}/{encoded callId}`. It uses the stable `ToolContext.callId`. Thus repeated model tool-call ids on later Turns create different children. `parent { threadKey, callId }` is in status records and index records. `scope.threads.list({ agent, parent })` filters by parent key, and `parent: null` selects roots. `delegation.started` and `delegation.completed` name the child with `childKey`. Approval events and pending approvals carry `child { threadId, seq }`. Answers go down to that Thread, and remembered grants stay there.
_Avoid_: sub-agent (for the child Agent), spawn, orchestration, handoff

**Usage record**:
A Usage record is a `usage.recorded` Thread event. The Harness persists it in the same transaction as the Step that it accounts for. It has one of three kinds:

- `model`, with the tokens (cache and reasoning tokens included), the model, the provider and `serverToolCalls`.
- `compaction`.
- `script`, with the tier and the wall time in milliseconds.

Each record has the stamp `{ scope, agent, user?, threadId, parent?, turn, seq }`. It has `cost { amount, currency, source, basis }` only when the provider or the gateway reported a cost in the response. OpenRouter reports `usage.cost`. Vercel AI Gateway reports `providerMetadata.gateway.cost`. The two values are on the final stream part. Cloudflare AI Gateway reports no cost in the response. For that gateway, the record keeps its `cf-aig-log-id` under `gateway`, and the Platform can join the record to the gateway log. karmi never calculates a price for tokens. A child Thread records its own usage with `parent` set. The Harness counts nothing two times.
_Avoid_: metric, billing event, usage log, telemetry

**UsageHandler**:
A UsageHandler is a Catalogue item that the Platform supplies. It receives Usage records in batches. A Queue delivers each batch at least once, with `threadId:seq` as the idempotency key. It is the billing seam. When it fails, the Queue tries again, and the Turn never fails. karmi keeps no counters for each Scope. Spend limits for a full Scope belong to the Platform, which enforces them through this handler.
_Avoid_: billing hook, metering, usage callback, meter

**Approval**:
An Approval is a pause in a Turn that only the answer of a person can end. An `approval.requested` Thread event shows it, and an `approval.resolved` Thread event resolves it. There are three kinds:

- `tool` is a Permission Policy `ask` on a Tool call.
- `continue` is a `longRunning` budget that has no remaining quantity.
- `connect` is a missing user-level Connection. The person completes OAuth to answer it.

The Framework records the person who answered (`by`). It never authorises that person. The Platform does. An answer is `allow` or `deny`. It is never an edit of the call. A timeout and a Turn cancel are denies. The timeout is `approvals.timeout`, with the Scope ceiling as the maximum. Allowed calls in the same tool batch run before the pause. A denied call is an `isError` Tool result that the model sees next. The Thread can remember an `allow` for the remainder of the Thread, by Tool name only. The parent Thread emits the Approvals of a delegated child again, and the person answers them there.
_Avoid_: permission prompt, confirmation, consent (for the pause), HITL request

**Test kit**:
The Test kit is the `@karmi/core/testing` export. It has `createTestKarmi()` and the doubles that it composes:

- `fakeProvider`, a scripted Provider profile that records its requests.
- `Clock`.
- `LocalProcessSandbox`.
- The brute-force `VectorStore`.
- An in-memory `SecretsProvider`.
- `fakeMcpServer`.

It also has the event-log matchers and Provider record and replay. Every double is a real implementation of a real seam. The core package has no behaviour that is only for tests. Tests run the real Thread DO in workerd under `@cloudflare/vitest-plugin`. There is no harness that runs only in Node.
_Avoid_: mocks (for the doubles), test harness, test utils

**Scoped fetch**:
Scoped fetch is the one egress seam. It is a `fetch` that the Framework builds for each Turn from the resolved Scope config. The Framework gives it to every outbound caller: Provider adapters, MCP transports and OAuth discovery. It has these rules:

- It rejects private and reserved addresses with a synthetic 403. A vendored SSRF guard does this check.
- It rejects hosts outside its allow-list with a synthetic 403. The allow-list comes from the gateway or the `baseUrl` of the Provider profile, or from the registered MCP servers.
- It forces manual redirects.
- It adds nothing to outbound requests.

Gateway headers belong to the adapter. They do not belong to Scoped fetch.
_Avoid_: outbound worker, proxy, egress hook (for this), fetch wrapper (as the concept)

**Clock**:
The Clock is the single injectable time source that `@karmi/core` reads for everything that depends on time. This includes the watchdog, park timeouts, Approval timeouts, Schedules and cron. The interface is `Clock.now()`, which returns epoch milliseconds. Inject it with `createKarmi({ clock })`. The default is wall time. In the Test kit, `clock.advance(milliseconds | "24h")` moves the Clock and fires the Durable Object alarms that are due. Thus you can test recovery, parking and scheduling without a wait.
_Avoid_: timer, fake timers, `Date.now()`
