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
A gated ability an Agent may be granted in its Agent Spec, such as running small generated scripts, outbound HTTP, remote MCP, or long-running loops. The Catalogue implements it; the Spec switches it on. Nothing not granted is reachable.
_Avoid_: permission, feature flag

**Tool**:
A named action an Agent can call: a JSON-Schema input, annotations (read-only, destructive, …), optional usage instructions as a Fragment, an optional required Connection, and code that executes it. Arrives from the Catalogue (code), from a remote MCP server (runtime, named `server__tool`), or as a Framework built-in; identical to an Agent Spec either way.
_Avoid_: function, action, integration, capability

**Permission Policy**:
Data in an Agent Spec: ordered rules matching Tools by name and annotation, each resolving to allow, ask (pause for a human) or deny. Scope-wide defaults are merged into the Spec by the Platform; the Framework sees one resolved policy per Agent.
_Avoid_: permission rules, ACL, guardrails

**Hook**:
A Catalogue item — code that runs at a lifecycle point (before a tool call, after a turn, on error) — attached to an Agent by name in its Spec.
_Avoid_: middleware, plugin, interceptor, callback

**Scope**:
The isolation key every Primitive and all secrets/config resolve under. Nothing in one Scope can see another. The Framework keys by it; the Platform decides what it represents (a tenant, a user, a workspace).
_Avoid_: tenant, organisation, account

**User**:
The principal an Agent is acting for or with — the person chatting, or the person whose events are being processed. Keyed under a Scope; a Scope has many Users. Per-User things (profile, memory, history, user-level Connections) live under (Scope, User). The caller maps channel identities to a User before the Framework sees them; the Framework never authenticates.
_Avoid_: end user, customer, principal, account

**Thread**:
One durable conversation between one Agent and one User, keyed (Scope, Agent, User, threadId); User may be absent for user-less Events. Driven by Turn inputs — User messages or Events. Holds the transcript and can be resumed or forked. Whether a User gets one Thread or many with an Agent is decided by the Channel binding, not by the Agent. A User's chat history with an Agent is simply their Threads with it.
_Avoid_: session, conversation, chat, channel

**Event**:
A non-chat Turn input: a typed JSON payload from a webhook, queue or schedule, concerning a User (or none), delivered into a Thread by the Channel binding and shown to the Agent through a Fragment. Not a Primitive of its own.
_Avoid_: trigger (for the input), message, notification, job

**Connection**:
A named, typed credential grant a Tool acts through, held at one of two levels: agent-level (Scope, Agent, name) — shared by every User of that Agent — or user-level (Scope, User, name) — granted by the User so the Agent acts on their behalf, usable across every Agent in the Scope. A Tool requires a Connection by name; user-level resolves before agent-level.
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
The strategy behind a Knowledge search or a Memory recall: given a query, return ranked passages. Full-text is the default; vector similarity is an alternative behind the same seam.
_Avoid_: vector store, index, embeddings (for the strategy)

**Agent**:
A configured actor the Framework runs: created from an Agent Spec and keyed (Scope, agentId). A Scope may hold any number of Agents, created at runtime by the Platform or written in code — same shape either way.
_Avoid_: bot, assistant, persona, agent definition (for the running thing)

**Agent Spec**:
The plain-data description an Agent is born from: name, instructions (with per-model variants), model choice, and references by name to Catalogue items — Tools, Fragments, Skills, Knowledge, Retrievers — plus Connections, Capability grants and Memory profile fields. Contains no code; the Framework validates it and reports errors.
_Avoid_: config, definition file, manifest, template

**Catalogue**:
Everything a developer defines in code and deploys with the Framework, available for Agent Specs to reference by name: Tools, Fragments, Skills, Retrievers. Shared by every Scope; the only place behaviour code lives.
_Avoid_: registry, library, plugins, toolbox
