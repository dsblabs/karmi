---
title: karmi guide
---

# karmi guide

This guide tells you how to build an agent project with karmi. It shows the public API only. The terms with capitals, for example Thread and Scope, are in the [glossary](../../CONTEXT.md).

## Core path

Read these pages in order.

1. [Getting started](./01-getting-started.md) creates a project, runs its tests and deploys it.
2. [Agents](./02-agents.md) describes `defineAgent`, instructions, models and Agent Specs as data.
3. [Tools](./03-tools.md) describes `defineTool`, annotations, Provider Tools, Skills and deferred Tools.
4. [Threads](./04-threads.md) describes Turns, Approvals, Compaction, forks and offline delivery.
5. [Providers](./05-providers.md) describes the Anthropic Provider, the AI SDK Provider and Cloudflare AI Gateway.
6. [HTTP](./06-http.md) describes the REST routes and the event streams.

## Topics

Read a topic page when you need it.

7. [Sandbox](./07-sandbox.md) describes Scripts, isolation and the container sandbox.
8. [Schedules](./08-schedules.md) describes Schedules, which send an Event to a Thread at a later time.
9. [Memory](./09-memory.md) describes what the Agents of a Scope remember about a User.
10. [Knowledge](./10-knowledge.md) describes Knowledge, retrievers, and vector and hybrid retrieval.
11. [MCP](./11-mcp.md) describes remote MCP servers.
12. [Credentials](./12-credentials.md) describes credential references, the credentials of a Scope and Secrets providers.
13. [Testing](./13-testing.md) describes the tests of an agent project.
14. [Observability](./14-observability.md) describes usage records and logging.
15. [Doctor](./15-doctor.md) describes `karmi doctor`.
16. [Deployment](./16-deployment.md) describes the deploy to Cloudflare, the bindings, and recovery and time.

## Reference

CI builds the API reference from the JSDoc of each package. The output goes in `docs/reference/`. The repository does not contain the output.
