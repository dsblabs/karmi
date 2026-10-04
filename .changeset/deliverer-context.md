---
"@karmi/core": minor
---

Changed the signature of `Deliverer.deliver` from `deliver(threadKey, events, ref)` to `deliver(events, ctx)`. `ctx` is the new exported type `DelivererContext`. It has `scope`, `threadKey` and `ref`. `ctx.scope` is the id of the Scope that owns the Thread.

A Thread key is unique only in one Scope. Before this change, a Deliverer did not get the Scope. A Platform with many tenants had to put the Scope in each `ref`, and a `ref` without it could send a reply through the Channel of the wrong tenant.

This is a breaking change. karmi does not support the old signature. Change each Deliverer to the new signature.

Before:

```text
defineDeliverer({
  name: "webhook",
  async deliver(threadKey, events, ref) {
    await send({ threadKey, events, ref });
  },
});
```

After:

```text
defineDeliverer({
  name: "webhook",
  async deliver(events, ctx) {
    await send({ scope: ctx.scope, threadKey: ctx.threadKey, events, ref: ctx.ref });
  },
});
```

If your Deliverer ignores a duplicate by the Thread key and the event `seq`, add `ctx.scope` to that key.
