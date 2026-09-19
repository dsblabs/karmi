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

Read a topic page when you need it. The topic pages have the numbers 07 to 16. They are not written yet.

## Reference

CI builds the API reference from the JSDoc of each package. The output goes in `docs/reference/`. The repository does not contain the output.
