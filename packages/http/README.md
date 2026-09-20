# @karmi/http

`@karmi/http` adds REST, Server-Sent Events and WebSocket routes to the karmi Thread API.

The Server-Sent Events stream and the WebSocket stream send the same JSON. Each frame is one `ThreadEvent`, the same object that `thread.events()` returns. A browser `EventSource` continues after a disconnect with no code of your own. The WebSocket hibernates while it is idle.

karmi has no authentication scheme. Your `authenticate` function reads the request and returns the Scope and the User.

Install the package:

```sh
pnpm add @karmi/core @karmi/http
```

Read these pages of the karmi guide:

- [HTTP](https://github.com/dsblabs/karmi/blob/main/docs/guide/06-http.md) describes the routes, the `authenticate` callback and the event streams.
- [Threads](https://github.com/dsblabs/karmi/blob/main/docs/guide/04-threads.md) describes Turns, Approvals and the events of a Thread.

For contributors, [`INTERNALS.md`](https://github.com/dsblabs/karmi/blob/main/packages/http/INTERNALS.md) describes the structure of the package.
