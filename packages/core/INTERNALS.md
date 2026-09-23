# @karmi/core internals

This file is for contributors to `@karmi/core`. It shows where the code is and which rules the code cannot show. The terms with capitals are in the [glossary](../../CONTEXT.md). The public API is in the [karmi guide](../../docs/guide/README.md).

## Source areas

All source files are in `src/`. The folder is flat. This table groups the files by area.

| Area              | Main files                                                                                                                                 | Function                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Deployment        | `karmi.ts`, `deployment.ts`, `bindings.ts`, `catalogue.ts`, `compat.ts`                                                                    | `createKarmi` builds the Deployment from the Catalogue and the bindings.                        |
| Scope             | `scope.ts`, `scope-config-do.ts`, `scope-config.ts`, `scope-destroy.ts`, `keys.ts`                                                         | The Scope API, the Agent Specs and their versions, and the config layers.                       |
| Thread and Turn   | `thread-do.ts`, `event-log.ts`, `input-queue.ts`, `turn-state.ts`, `thread-events.ts`, `transcript.ts`, `compaction.ts`, `fork.ts`         | The Thread Durable Object, the event log and the Turn loop.                                     |
| Thread client     | `thread.ts`, `thread-protocol.ts`, `thread-sockets.ts`, `thread-subscription.ts`, `deliverer.ts`                                           | The Thread API, the request decoders and the client sockets.                                    |
| Agents and Tools  | `agent.ts`, `agent-spec.ts`, `validate.ts`, `tool.ts`, `tool-step.ts`, `policy.ts`, `hooks.ts`, `skill.ts`, `prompt.ts`, `delegation.ts`   | The definitions, the validation, the Permission Policy and the Tool Step.                       |
| Providers         | `provider.ts`, `provider-output.ts`, `provider-tools.ts`, `usage.ts`, `retry.ts`, `platform-failure.ts`                                    | The Provider interface, the usage records and the retry rules.                                  |
| Memory            | `memory.ts`, `memory-do.ts`                                                                                                                | The Memory API and its Durable Object.                                                          |
| Knowledge         | `knowledge.ts`, `knowledge-do.ts`, `knowledge-store.ts`, `retriever.ts`, `vector-store.ts`, `sqlite-vector-store.ts`, `vectorize-store.ts` | Knowledge storage, retrievers and the two vector stores.                                        |
| MCP               | `mcp-client.ts`, `mcp-registry.ts`, `mcp-catalog.ts`, `mcp-oauth.ts`, `mcp-oauth-routes.ts`                                                | The MCP client, the cached catalogues and the OAuth flow.                                       |
| Media             | `media.ts`, `media-ingress.ts`, `media-url.ts`, `spill.ts`                                                                                 | The media refs in R2 and the Tool output that is too large for the log.                         |
| Scripts           | `sandbox.ts`, `isolate-sandbox.ts`, `container-sandbox.ts`, `cloudflare-container.ts`, `scripts.ts`, `thread-workspace.ts`                 | The `Sandbox` interface, its isolate and container adapters, and the Workspace of a Thread.     |
| Alarms and queues | `scheduler.ts`, `schedule.ts`, `cron.ts`, `queue.ts`                                                                                       | The alarm table, Schedules and the Queue consumer.                                              |
| `karmi doctor`    | `doctor.ts`, `vector-doctor.ts`                                                                                                            | The project checks.                                                                             |
| Test kit          | `testing/`                                                                                                                                 | The `@karmi/core/testing` entry: `createTestKarmi`, `fakeProvider`, the clock and the matchers. |
| Databases         | `db/`                                                                                                                                      | One folder for each Durable Object database, with `schema.ts` and `migrations/`.                |

The package has three public entries: `src/index.ts`, `src/testing/index.ts` and `src/sandbox-runtime.ts`.

## The flow of a Turn

1. `createKarmi` in `karmi.ts` builds a Deployment. It reads runtime bindings when an entry point first uses them. `makeDurableObjects` makes the four Durable Object classes from that Deployment.
2. `karmi.scope(id)` calls `openScope` in `scope.ts`. `scope.thread(target)` calls `openThread` in `thread.ts`.
3. `openThread` decodes the key or the identity and builds a `ThreadAddress`. It gets the Durable Object stub from the name that `keys.ts` makes.
4. `thread.send()` calls `send` on the Thread Durable Object in `thread-do.ts`. Each entry point first checks the address and the identity.
5. `send` writes the input to the `inputs` table and does not yield before the write is complete. An input with `steer` joins the Turn in progress. Other inputs go together into the next Turn.
6. `send` starts the Turn loop and does not wait for it. The rows in storage let the loop continue after an eviction. The loop does not use `waitUntil`.
7. On the first Step, the loop takes the config of the Turn from the Scope and stores it. Model Steps and Tool Steps then alternate. The Turn ends when a model Step returns no Tool calls.
8. A failed model call moves to the next model or Provider profile. The final failure records the safe fields of the last `ProviderError`.
9. `tool-step.ts` runs the Tool calls. An Approval, a Job or a Delegation parks the Turn. The answer or an alarm continues it.
10. Compaction is a Step of its own. It adds one `thread.compacted` event and does not change the log before that event.
11. The Thread Durable Object writes each usage record in the same write as its event.

`@karmi/http` uses the same path. It decodes each request with the functions in `thread-protocol.ts` and then calls the Thread API.

## Rules that the code cannot show

- Only `EventLog` in `event-log.ts` reads or writes the `events` table. It assigns each `seq`, decodes the `json` column and has one named read for each question about the log. The Thread Durable Object does not query the table. The `append` of the Durable Object calls `EventLog.append` first. Then it fills the outboxes, sends the event to the Subscribers and tells the parent Thread, in that order and in the same synchronous write.
- One SQL statement of a Durable Object binds at most 100 values. A statement that takes a list of unknown length splits the list with `boundBatches` in `db/bound-values.ts`. `EventLog.seed` and `EventLog.usageRecords` are examples. The linter refuses the list forms that skip it.
- A module that owns Thread tables takes only the database in its constructor. `openThreadDatabase` in `db/thread/database.ts` opens that database for a direct test. `test/event-log.test.ts`, `test/input-queue.test.ts`, `test/usage-outbox.test.ts` and `test/delivery-outbox.test.ts` are examples. Such a test contains only the rules of the module. The Turn-level tests show that the modules work together.
- Each module that owns Thread tables has a `clear()`. The delete of a Thread calls each `clear()` in one transaction. Thus a new table of a module cannot stay behind after a delete.
- `UsageOutbox` in `usage.ts` owns the `usage_outbox` table. It holds only the `seq` of each Usage record. The record is in the event log.
- `DeliveryOutbox` in `deliverer.ts` owns the `delivery_route` and `deliveries` tables. It calculates the event range of each delivery. The Thread Durable Object sets the `delivery` alarm and sends the range and its route to the Queue. After the Queue accepts the message, or skips because a Subscriber is attached, the Durable Object drops every range whose `delivery` Alarm has run, except the ranges of an open Turn. `enqueue` reads those to place the next range of the Turn. A range kept for an open Turn is dropped by the next `delivery` Alarm after the Turn ends. It sets the route from the `channelRef` of an input in `send` and when a Schedule fires.
- `InputQueue` in `input-queue.ts` owns the `inputs` table. Each `take` reads and removes the inputs in one synchronous step. The Thread Durable Object must log them before it yields, or an eviction loses them.
- The Thread Durable Object queries only the tables that have no module: `thread` and `deleted`.
- `ThreadWorkspace` owns `container_run`, `container_workspace`, the `container-idle` and `container-watchdog` alarms and the Scope container slot. The Thread decides when a Turn ends and calls `destroy()`. The Workspace records the end of a Job in the same write that clears `container_run`. The delete of a Thread also empties `alarms`.
- The event log is append-only. The `seq` column is the primary key of the `events` table. Compaction and a Fork do not change rows. A Fork copies rows into a new Thread.
- Each Durable Object owns its data. The Thread Durable Object owns the event log, the inputs, the Schedules and the Delegation state. It also owns the container state and the usage records that wait for delivery. The Scope config Durable Object owns the Agent Specs, the connections and the config. The Memory and Knowledge Durable Objects own their records. A retriever does not own Knowledge storage ([ADR 0006](../../docs/adr/0006-retrievers-do-not-own-knowledge-storage.md)).
- Only `keys.ts` makes Durable Object names and R2 prefixes. Isolation between Scopes relies on these names ([ADR 0001](../../docs/adr/0001-scope-name-based-isolation.md)).
- Each Durable Object runs its migrations in its constructor, inside `blockConcurrencyWhile`. `pnpm db:generate` writes the migrations into `db/*/migrations/index.ts` as inline text. Thus a project needs no Wrangler module rule ([ADR 0005](../../docs/adr/0005-durable-object-migrations.md)). Do not edit a migration after a release.
- A Durable Object has one alarm. `Scheduler` in `scheduler.ts` keeps all alarm kinds in the `alarms` table and sets the one alarm to the earliest row.
- Read the time from `deployment.clock.now()`. Only `clock.ts` and `src/testing/` call `Date.now()`. The test clock cannot move time for code that ignores this rule.
- An MCP session stops when its Turn stops or parks. A Turn that continues opens a new session from the cached catalogues.
- A client WebSocket ends in the Thread Durable Object, not in the Worker ([ADR 0003](../../docs/adr/0003-client-sockets-in-the-thread-do.md)).
- A Fork copies its media ([ADR 0004](../../docs/adr/0004-forks-copy-their-media.md)).
- The linter enforces the code rules in `eslint.guardrails.js` and `eslint.config.js`. Examples are no decorators ([ADR 0002](../../docs/adr/0002-compatibility-baseline.md)), no `node:*` imports, and no `storage.sql.exec` outside `src/db/`.

## Tests

The tests are in `test/`, with one `*.test.ts` file for each topic. They run in workerd with `@cloudflare/vitest-plugin`.

- `test/wrangler.jsonc` is the one Wrangler config for all tests. It points the published baseline at `test/worker.ts`.
- `test/worker.ts` has the Agents, Tools and Hooks that the tests share. The other fixtures are `container-fixtures.ts`, `knowledge-fixtures.ts` and `migration-fixtures.ts`.
- `test/setup.ts` adds the matchers from `src/testing/`.
- `test/__snapshots__/migrations.test.ts.snap` holds the SQL schema of each database. A schema change must update it.
- `sandbox.test.ts` skips one test, because local workerd does not enforce CPU limits.
- `vitest.vector-bench.config.mts` and `vitest.vectorize-live.config.mts` are optional. CI does not run them.

`pnpm --filter @karmi/core test` runs the tests and then `scripts/check-worker-bundle.mjs`. That script does a `wrangler deploy --dry-run` to make sure that the Worker bundle builds.

## Vendored code

`src/vendor/codemode/` has `codec.ts` and `runtime.ts` from the Cloudflare `agents` repository, under the MIT license. `NOTICE` gives the source commit and lists the parts that karmi changed or omitted. The npm package includes `NOTICE` and `LICENSE`.

`isolate-sandbox.ts` and `script-results.ts` use this code. The JSDoc lint rules do not apply to `src/vendor/`. When you update the code, update the commit in `NOTICE`.
