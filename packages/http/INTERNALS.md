# @karmi/http internals

This file is for contributors to `@karmi/http`. The routes and the streams are in the [HTTP guide page](../../docs/guide/06-http.md). The terms with capitals are in the [glossary](../../CONTEXT.md).

## Source areas

| File           | Function                                                           |
| -------------- | ------------------------------------------------------------------ |
| `handler.ts`   | `createHttpHandler`, the route table and the authentication step.  |
| `decode.ts`    | The decoders for the query and the JSON bodies.                    |
| `multipart.ts` | The change from a `multipart/form-data` body to Parts and uploads. |
| `sse.ts`       | The Server-Sent Events stream.                                     |
| `errors.ts`    | The map from a karmi error code to an HTTP status.                 |

## The flow of a request

1. `handler.ts` splits the path into the root, the key, the action and the argument.
2. A path that is not below `/threads` returns `undefined`. Thus the Worker can serve its own routes. `fetch` changes `undefined` into a 404.
3. Each route calls `authenticate` first. A `null` result gives a 401.
4. The route opens the Thread with the key. A key for a different User gives a 404.
5. The route decodes the body and calls the Thread API of `@karmi/core`.

A WebSocket upgrade does not end in the Worker. `thread.socket()` in `@karmi/core` sends the upgrade to the Thread Durable Object, which owns the socket and hibernates when the socket is idle. The reason is in [ADR 0003](../../docs/adr/0003-client-sockets-in-the-thread-do.md).

## Rules that the code cannot show

- Import only from `@karmi/core`, `zod/mini` and the files of this package. The package proves that the public API of `@karmi/core` is sufficient for a transport.
- The package has no authentication scheme. All authority comes from the `authenticate` callback.
- A stream frame is one `ThreadEvent` with no changes. Do not add a second event format.

## Tests

The tests run the Worker in workerd. `createTestKarmi` from `@karmi/core/testing` supplies the Deployment.

- `test/rest.test.ts` and `test/stream.test.ts` call each route through `SELF.fetch`. This includes the SSE bodies and the WebSocket upgrades.
- `test/boundary.test.ts` reads each source file and fails on an import that the first rule does not permit. The linter enforces the same rule.
- `test/worker.ts`, `test/helpers.ts` and `test/wrangler.jsonc` are the fixtures.
