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
A first-class building block the Framework exposes above the Harness — e.g. agent, dynamic prompt, tool. The exact set is being decided.
_Avoid_: component, module, feature

**Channel**:
An external surface through which a human or event reaches a session — a chat UI, a chat app, inbound email, a webhook. Channel integrations live outside karmi.
_Avoid_: integration, connector, frontend

**Capability**:
A gated ability an agent may be granted by configuration, such as running small generated scripts.
_Avoid_: permission, feature flag

**Scope**:
The isolation key every Primitive and all secrets/config resolve under. The Framework keys by it; the Platform decides what it represents (a tenant, a user, a workspace).
_Avoid_: tenant, organisation, account
