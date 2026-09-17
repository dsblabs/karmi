# 3. Client sockets live in the Thread Durable Object

Date: 2026-09-17. Status: accepted. Decided in [@karmi/http: hibernating WebSocket needs a push seam in core](https://github.com/dsblabs/karmi/issues/94).

## Context

`@karmi/http` ([#66](https://github.com/dsblabs/karmi/issues/66)) shipped its WebSocket route as a `WebSocketPair` accepted by the Worker that received the upgrade, pumping `thread.subscribe()` under `ctx.waitUntil`. The acceptance criteria asked for a hibernating Durable Object socket and did not get one.

The reason is `subscribe()` itself. It is a long-poll: the Thread API calls `poll()` on the Thread DO, which parks on an in-memory waiter list for up to fifteen seconds and returns, and the caller immediately polls again. A Durable Object cannot hibernate while a request is in flight and is billed for wall-clock active duration, so **an idle Thread with one attached client is billed continuously, forever**. The same is true of the SSE route, which streams the same `subscribe()`. Moving the socket into a hibernating Durable Object of its own would not have changed this: that object would have had to long-poll the Thread DO to get anything to forward, keeping both awake and adding a Durable Object class and a wrangler binding to every consumer of the package.

The issue therefore asked for a push seam in core — a way for the Thread DO to notify a subscriber object on append, so that object could hibernate between events. Working through it produced the observation that makes the seam unnecessary:

> Every `append()` happens while the Thread DO is executing. Events are only ever produced by a running Turn, a scheduled wake, a job callback or a delegation notify, all of which have the object awake by definition. While a Thread is idle there is nothing to push; while it is producing there is nothing to wake.

There is no sleeping receiver, so there is nothing for a push seam to do. What remained was to stop routing the events through an object that has to stay awake to relay them.

## Decision

- **The Thread Durable Object accepts client WebSockets directly** via `ctx.acceptWebSocket`, and `append()` sends to the attached sockets as part of writing the event. A Thread with Subscribers attached but no Turn running holds no request and hibernates. There is no subscriber registry, no second Durable Object class and no new binding.
- **The Thread DO gains a `fetch` handler**, whose only job is the WebSocket upgrade. Every other call into every core Durable Object remains RPC through the `remote()` helper. This is a deliberate, single exception: `WebSocket` is not an RPC-serializable type, and `fetch` is the documented upgrade path into a Durable Object.
- **The public API is `thread.socket(options?): Promise<Response>`.** Core synthesizes the internal upgrade request itself; the caller returns the `101` response it gets back. No `Request` in the signature, and no promise for the caller to hold open — the absence of anything to `ctx.waitUntil` is the point. `connect()` was rejected as a name because `Connection` already means an MCP grant.
- **The long-poll is deleted.** `subscribe()` is rebuilt over an internal socket to the Thread DO, and `poll()`, `nextAppend()`, the waiter list and the poll timeout go with it. The SSE route holds its response open in the Worker — which bills CPU, not wall-clock — and feeds it from an internal socket. Every transport now lets the Thread DO hibernate, and core has one delivery path instead of two.
- **The socket is duplex and the frame protocol lives in core.** `send`, `steer`, `cancel` and `approve` frames and the `ack`/`error` envelope move inward, where they dispatch to the Durable Object's own methods. Every verb in the protocol is a Thread API method, so it is the Thread wire protocol rather than an HTTP-package invention; `@karmi/http` re-exports the types and its published protocol is unchanged.
- **A Subscriber is anyone attached.** The Deliverer's "no live subscriber" test reads `ctx.getWebSockets()` at delivery time instead of waiting for a subscriber to acknowledge the event, which removes the `consumed()` round-trip and the one-second race it depended on.
- **The event log is the buffer.** Core applies no backpressure policy of its own: the runtime exposes no `bufferedAmount` to a Durable Object and already closes a socket whose send buffer fills. A client that cannot keep up is closed, reconnects with the last `seq` it saw, and replays from the log.
- **A socket streams from the current head by default**; replay is opted into with `after`. History remains a REST concern.

## Consequences

- Core knows what a WebSocket is, which is the thing a reader will want to "fix" on finding that `@karmi/http` exists to keep transports out of core. The boundary that matters is preserved in substance: the frames carry `ThreadEvent` verbatim and the four Thread API verbs, so core is not learning an HTTP protocol, it is publishing its own.
- A socket's authority is fixed at upgrade time. The Thread address is bound when `thread.socket()` is called, so a socket can never act on another Thread — but a client whose credential is revoked mid-socket keeps its authority until it disconnects. This was already true of the Worker-side implementation and is documented rather than solved.
- Hibernation-safety is now a property that must hold: per-socket state lives in the socket's attachment, never in an instance field. It is tested by evicting the Durable Object with `evictDurableObject(stub, { webSockets: "hibernate" })` while a socket is attached and asserting the socket still receives the next Turn's events. The installed Cloudflare test runtime supports this [hibernation-preserving eviction](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/). `state.abort()` instead disconnects attached sockets with code `1006`; a separate test verifies reconnect and replay after that failure.
- Attachment is not the same as the right audience. An operator's debug socket suppresses an end user's Deliverer notification. The acknowledgement model had the identical flaw; socket tags make audience-scoped delivery a small change when someone needs it, and it is not built in v0.
- A socket with no `after` no longer replays the log, which changes the behaviour of a shipped default while both packages are at `0.0.0`.
