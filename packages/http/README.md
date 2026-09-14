# @karmi/http

REST, Server-Sent Events and WebSocket routes over the karmi Thread API, behind an authentication callback you write. A browser or any HTTP client drives Threads without a transport of its own, and every route uses only the public `@karmi/core` API.

```ts
import { createKarmi } from "@karmi/core";
import { createHttpHandler } from "@karmi/http";

const karmi = createKarmi({ catalogue });
const http = createHttpHandler({
  karmi,
  // Your session check. Return the Scope and User, or null for a 401. karmi has no auth scheme of its own.
  authenticate: async (request) => {
    const session = await verify(request.headers.get("authorization") ?? new URL(request.url).searchParams.get("token"));
    return session ? { scope: session.tenant, user: session.userId } : null;
  },
});

export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;
export default { fetch: http.fetch, queue: karmi.queueHandler };
```

`http.handle(request, ctx)` answers only paths under `/threads` and returns undefined for anything else, so a Worker can mount it beside its own routes and `karmi.oauth.handle`.

## Routes

Threads are addressed by their opaque key, which `POST /threads` and `GET /threads` return. A key encodes the User, and a key whose User is not the authenticated one answers 404. A Principal without a User drives user-less Threads only.

| Route                                     | Body                                                             | Answer                                         |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `POST /threads`                           | `{ agent, threadId? }`                                           | `201` the Thread: identity, `key`, `status`    |
| `GET /threads?agent=`                     |                                                                  | `ThreadSummary[]`, most recently active first  |
| `GET /threads/:key`                       |                                                                  | the Thread, or a WebSocket on `Upgrade`        |
| `POST /threads/:key/turns`                | a `TurnInput` plus `steer?`, or `multipart/form-data`            | `202 { turn, seq }`                            |
| `GET /threads/:key/events?after=`         | `Accept: text/event-stream` streams, anything else returns JSON  | `ThreadEvent[]` or an SSE stream               |
| `POST /threads/:key/approvals/:seq`       | `ApprovalAnswer`                                                 | `204`, `409` once answered, `404` unknown seq  |
| `POST /threads/:key/cancel`               |                                                                  | `204`                                          |
| `POST /threads/:key/compact`              | `{ instructions? }`                                              | `204`, `409` while a Turn runs or is parked    |

A JSON Turn carries text Parts only. Media reaches a Thread through a multipart Turn: every `text` field becomes a text Part and every file is stored under the Thread with `thread.uploads.put` and becomes an `image`, `video`, `audio` or `file` Part, in the order posted. `skill`, `channelRef` (as JSON) and `steer` (`"true"`) fields mean what they mean on a JSON Turn.

Errors are `{ error: { code, message } }`. A karmi code maps to its status: a missing target is 404, a state conflict such as `approval.resolved` or `thread.busy` is 409, bad input is 400, a rejected upload is 413 or 415.

## Streams

SSE and WebSocket carry the same JSON: each frame is one `ThreadEvent` exactly as `thread.events()` returns it. Both replay the log after `after` (default the whole log) and then stream live, so a client that remembers the last `seq` it saw loses nothing across a reconnect. An SSE record's `id` is the event's `seq`, and the route reads `Last-Event-ID`, so a browser `EventSource` resumes on its own. `granularity` is `delta` (default), `part` or `turn`, as on `thread.subscribe()`.

A WebSocket client sends JSON frames and gets an `ack` or `error` frame back, correlated by an optional `id` of its choosing:

```jsonc
{ "id": 1, "type": "send", "input": { "kind": "message", "parts": [{ "type": "text", "text": "Hi" }] }, "steer": false }
{ "id": 2, "type": "steer", "input": { "kind": "message", "parts": [{ "type": "text", "text": "Shorter" }] } }
{ "id": 3, "type": "cancel" }
{ "id": 4, "type": "approve", "seq": 8, "answer": { "decision": "allow", "by": "alice" } }
// answers
{ "type": "ack", "id": 1, "result": { "turn": 1, "seq": 0 } }
{ "type": "error", "id": 4, "error": { "code": "approval.resolved", "message": "..." } }
```

The socket is served by the Worker that accepted it, not by a Durable Object, and it lives as long as that Worker does. A client reconnects with `?after=<last seq>` and continues where it left off.

## Tests

The suite runs the real Worker in workerd: `createTestKarmi` from `@karmi/core/testing` supplies the Deployment and a bearer-token `authenticate`, and every route is exercised through `SELF.fetch`, including SSE bodies and WebSocket upgrades. A boundary test reads every source module and fails on any import other than `@karmi/core`, `zod/mini` and the package's own files. The linter enforces the same rule.
