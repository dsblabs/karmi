# karmi

karmi is a TypeScript framework for agent products that serve many customers. You write Agents and Tools in code. karmi runs them on Cloudflare Workers, and you operate no servers.

To build a project with karmi, read the [karmi guide](./docs/guide/README.md). To work on karmi, read [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Reasons to use karmi

The terms with capitals, for example Thread and Scope, are in the [glossary](./CONTEXT.md).

### An Agent that waits uses no compute

A Turn parks while it waits for an Approval, a budget or a Job. A parked Turn uses no Worker time. An idle Thread with attached clients has no cost. A Schedule starts the Agent again after a delay, at a set time or on a cron. Read [Threads](./docs/guide/04-threads.md) and [Schedules](./docs/guide/08-schedules.md).

### A restart does not lose work

Cloudflare can stop a Durable Object at any time. The Thread then continues from its event log, and you write no code for this. karmi keeps the results of the Tool calls that finished. It runs an interrupted call again only if you marked the Tool as safe to run two times. Read [Deployment](./docs/guide/16-deployment.md#recovery).

### Customer isolation is part of the model

Every Agent, Thread, Memory and secret resolves under a Scope. karmi has no operation that crosses Scopes. Each Scope can own its Provider credential, and a revocation applies at the next Step. `scope.destroy()` removes the Threads, the Memories, the Knowledge and the files of the Scope. It also revokes the credentials of the Scope. Read [Credentials](./docs/guide/12-credentials.md).

### Your customers can make Agents with no deploy

An Agent Spec is plain JSON with no code. Your product stores an Agent Spec for a Scope at runtime. A ceiling on the Scope limits the Capabilities that each Agent Spec can grant. Read [Agents](./docs/guide/02-agents.md#agent-specs-as-data).

### A person approves the actions that have risk

The rules of a Permission Policy resolve each Tool call to allow, ask or deny. Ask stops the Turn until a person answers. When the Thread has no Subscriber, a Deliverer sends the Approval to a Channel such as email or a chat app. Read [Threads](./docs/guide/04-threads.md#approvals).

### Code that the model writes cannot reach your systems

A Script in the isolate tier has no filesystem, egress, secrets or storage. Its only API is the Tools that the Agent can call. Each of those calls goes through the Permission Policy again. Read [Sandbox](./docs/guide/07-sandbox.md).

### Tests need no model and no Provider credential

The Test kit runs your Catalogue in workerd against a scripted Provider. `karmi doctor` finds configuration that stops a Deployment before `wrangler deploy` does. Read [Testing](./docs/guide/13-testing.md) and [Doctor](./docs/guide/15-doctor.md).

### You can bill each customer

karmi stores a Usage record in the same transaction as the Step that it accounts for. Each record names the Scope, the Agent, the User and the Thread. A Queue delivers the records to your `UsageHandler` at least once. Read [Observability](./docs/guide/14-observability.md).

### You can change the model vendor

karmi has a Provider for the Anthropic Messages API and a Provider for each model package of the AI SDK. A Provider profile can use Cloudflare AI Gateway. It can also fall back to a credential of the Deployment. Read [Providers](./docs/guide/05-providers.md).

## When karmi does not fit

- karmi runs only on Cloudflare Workers.
- karmi does not authenticate. Your code maps each request to a Scope and a User.
- karmi has no sign-up, no billing and no Channel integrations. Your product owns them.

## Quick start

Run these commands to create a project and test it:

```sh
pnpm create karmi my-agent
cd my-agent
pnpm install
pnpm typecheck && pnpm test
```

[Getting started](./docs/guide/01-getting-started.md) describes the project files and the deploy.

## Playground

The [Playground](./examples/playground) is an example webapp in this repository. It shows the Framework through guided scenarios in a browser. It runs locally with your own Provider credential and needs no Cloudflare login.

## Packages

| Package                                                    | Contents                                                      | Internals                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| [`@karmi/core`](./packages/core)                           | The Harness, the Thread API, `karmi doctor` and the test kit. | [`INTERNALS.md`](./packages/core/INTERNALS.md)              |
| [`@karmi/anthropic`](./packages/anthropic)                 | The Provider for the Anthropic Messages API.                  |                                                             |
| [`@karmi/ai-sdk`](./packages/ai-sdk)                       | The Provider for AI SDK model packages.                       |                                                             |
| [`@karmi/http`](./packages/http)                           | The REST, Server-Sent Events and WebSocket routes.            | [`INTERNALS.md`](./packages/http/INTERNALS.md)              |
| [`@karmi/sandbox-container`](./packages/sandbox-container) | The container image and the local runtime for Scripts.        | [`INTERNALS.md`](./packages/sandbox-container/INTERNALS.md) |
| [`create-karmi`](./packages/create-karmi)                  | The command that creates a project, and the project template. |                                                             |

## Docs

| Path                                | Contents                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| [`docs/guide/`](./docs/guide)       | The user docs for the public API.                                                   |
| `docs/reference/`                   | The API reference. CI builds it from the JSDoc. The repository does not contain it. |
| [`CONTEXT.md`](./CONTEXT.md)        | The glossary of karmi terms.                                                        |
| [`llms.txt`](./llms.txt)            | The index of the guide for coding agents. A script writes it from the guide index.  |
| [`docs/adr/`](./docs/adr)           | The architecture decision records.                                                  |
| [`docs/agents/`](./docs/agents)     | The rules for writing, comments, TypeScript and the issue tracker.                  |
| [`docs/research/`](./docs/research) | The research notes that the decisions use.                                          |
| [`AGENTS.md`](./AGENTS.md)          | The principles and rules for all contributors.                                      |
