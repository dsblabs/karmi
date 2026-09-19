---
title: HTTP
---

# HTTP

`@karmi/http` gives REST, Server-Sent Events (SSE) and WebSocket routes for the Thread API. A browser or a different HTTP client can then use Threads with no transport code of your own.

## Mount the routes

`createHttpHandler` takes the `karmi` object and an `authenticate` function. karmi has no authentication scheme. Your function reads the request and returns the Scope and the User, or `null` for a `401` answer. This sample accepts one bearer token:

```ts
import { createKarmi, defineAgent } from "@karmi/core";
import { createHttpHandler, type Principal } from "@karmi/http";
import { env } from "cloudflare:workers";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

const karmi = createKarmi({ catalogue: { agents: [supportAgent] } });

const authenticate = (request: Request): Principal | null => {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
  return token && token === env.API_TOKEN ? { scope: "acme", user: "alice" } : null;
};

const http = createHttpHandler({ karmi, authenticate });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export default { fetch: http.fetch, queue: karmi.queueHandler };
```

A browser cannot set headers on an `EventSource` or a `WebSocket`. Thus the sample also reads the token from the `token` query parameter.

`http.handle(request, ctx)` answers only the paths below `/threads`. It returns `undefined` for each other path. Use it to mount the routes next to your own routes.

## Routes

A route addresses a Thread by its opaque `key`. `POST /threads` and `GET /threads` return the key. The key contains the User. A key for a different User gets a `404` answer. A Principal with no User can use user-less Threads only.

| Route                               | Body                                                  | Answer                                                        |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `POST /threads`                     | `{ agent, threadId? }`                                | `201` with the Thread: identity, `key`, `status`              |
| `GET /threads?agent=`               |                                                       | `ThreadSummary[]`, most recent first                          |
| `GET /threads/:key`                 |                                                       | The Thread, or a WebSocket on `Upgrade`                       |
| `POST /threads/:key/turns`          | A `TurnInput` with `steer?`, or `multipart/form-data` | `202 { turn, seq }`                                           |
| `GET /threads/:key/events?after=`   |                                                       | `ThreadEvent[]`, or an SSE stream                             |
| `POST /threads/:key/approvals/:seq` | An `ApprovalAnswer`                                   | `204`. `409` for a second answer. `404` for an unknown `seq`. |
| `POST /threads/:key/cancel`         |                                                       | `204`                                                         |
| `POST /threads/:key/compact`        | `{ instructions? }`                                   | `204`. `409` while a Turn runs or is parked.                  |

`GET /threads/:key/events` returns an SSE stream when the request has `Accept: text/event-stream`. With a different `Accept` value, it returns JSON.

### Media

A JSON Turn can contain text Parts only. Send media in a `multipart/form-data` Turn:

- Each `text` field becomes a text Part.
- Each file becomes an `image`, `video`, `audio` or `file` Part. karmi stores the file under the Thread.
- The Parts keep the order of the fields.
- The fields `skill`, `channelRef` (as JSON) and `steer` (`"true"`) have the same meaning as in a JSON Turn.

### Errors

An error answer has the body `{ error: { code, message } }`.

| Status         | Cause                                                               |
| -------------- | ------------------------------------------------------------------- |
| `400`          | The input is not valid.                                             |
| `401`          | `authenticate` returned `null`.                                     |
| `404`          | The target does not exist.                                          |
| `409`          | A state conflict, for example `approval.resolved` or `thread.busy`. |
| `413` or `415` | karmi rejected an upload.                                           |

## Streams

SSE and WebSocket send the same JSON. Each frame is one `ThreadEvent`, the same object that `thread.events()` returns.

- Both streams send live events by default. Add `after` to get the stored events first.
- `granularity` is `delta` (the default), `part` or `turn`.
- The `id` of an SSE record is the `seq` of the event. The route reads `Last-Event-ID`. Thus a browser `EventSource` continues after a disconnect with no code of your own.

### WebSocket

The Durable Object of the Thread owns the WebSocket. The socket hibernates while it is idle, so `ctx.waitUntil` is not necessary.

karmi checks the Principal one time, at the upgrade. A revoked credential has an effect only when the socket disconnects.

Close code `4004` tells that the Thread or the Scope no longer exists. The client must not connect again. After each other close code, connect again with `?after=<last seq>`.

A client sends JSON frames. Each frame can have an `id` that the client selects. The answer is an `ack` frame or an `error` frame with the same `id`. These are examples of the client frames and the answers:

```jsonc
{ "id": 1, "type": "send", "input": { "kind": "message", "parts": [{ "type": "text", "text": "Hi" }] }, "steer": false }
{ "id": 2, "type": "steer", "input": { "kind": "message", "parts": [{ "type": "text", "text": "Shorter" }] } }
{ "id": 3, "type": "cancel" }
{ "id": 4, "type": "approve", "seq": 8, "answer": { "decision": "allow", "by": "alice" } }
// Answers from the server:
{ "type": "ack", "id": 1, "result": { "turn": 1, "seq": 0 } }
{ "type": "error", "id": 4, "error": { "code": "approval.resolved", "message": "The Approval has an answer." } }
```

This is the last page of the core path. The [guide index](./README.md) lists the topic pages.
