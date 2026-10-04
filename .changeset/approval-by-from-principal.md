---
"@karmi/core": minor
"@karmi/http": minor
---

Changed the source of the `by` of an Approval answer on the HTTP routes and the WebSocket. The name now comes from the authenticated Principal. Before this change, a client that could reach a Thread could record an answer under any name.

This is a breaking change. `POST /threads/:key/approvals/:seq` answers `400` with the code `http.badRequest` for a body that has a `by` field. An `approve` frame that has a `by` in its `answer` gets an `error` frame with the same code. In the two cases the Approval stays open.

Remove `by` from the request body and from the frame.

Before:

```jsonc
// POST /threads/:key/approvals/8
{ "decision": "allow", "by": "alice" }
// WebSocket frame
{ "id": 4, "type": "approve", "seq": 8, "answer": { "decision": "allow", "by": "alice" } }
```

After:

```jsonc
// POST /threads/:key/approvals/8
{ "decision": "allow" }
// WebSocket frame
{ "id": 4, "type": "approve", "seq": 8, "answer": { "decision": "allow" } }
```

The routes record `principal.user` as before. To record a different name, return the new optional `by` field of `Principal` from `authenticate`:

```ts
const authenticate = (request: Request): Principal | null => ({ scope: "acme", user: "u_42", by: "Alice Smith" });
```

A Principal that has no `by` and no `user` records no name.

If your Worker calls `thread.socket()` itself, give the name in the new `by` option, for example `thread.socket({ by: "Alice Smith" })`. Each `approve` frame on that socket records that name, also after the socket hibernates. `decodeApprovalAnswer` now returns the new `ClientApprovalAnswer` type, which has no `by`.

`thread.approve(seq, { by })` did not change.
