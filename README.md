# karmi

karmi is a TypeScript framework that runs agents on Cloudflare Workers. You write Agents and Tools in code, and karmi runs them in Threads that keep their state in Durable Objects.

To build a project with karmi, read the [karmi guide](./docs/guide/README.md). To work on karmi, read [`CONTRIBUTING.md`](./CONTRIBUTING.md).

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
| [`docs/adr/`](./docs/adr)           | The architecture decision records.                                                  |
| [`docs/agents/`](./docs/agents)     | The rules for writing, comments, TypeScript and the issue tracker.                  |
| [`docs/research/`](./docs/research) | The research notes that the decisions use.                                          |
| [`AGENTS.md`](./AGENTS.md)          | The principles and rules for all contributors.                                      |
