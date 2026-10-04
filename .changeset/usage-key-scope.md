---
"@karmi/core": minor
---

Changed the format of the key that `usageKey(record)` returns from `threadId:seq` to `scope:threadId:seq`. A Thread id is unique only in one Scope. Before this change, two Scopes that used the same Thread id gave the same key for different Usage records. A `UsageHandler` that deduplicates by `usageKey` then dropped the usage of one Scope.

This is a breaking change. The parameter of `usageKey` must now have a `scope`. A `UsageRecord` has one, so `usageKey(record)` in a `UsageHandler` needs no change. Add the `scope` where you call `usageKey` with an object of your own.

Before:

```ts
usageKey({ threadId: "t_1", seq: 4 }); // "t_1:4"
```

After:

```ts
usageKey({ scope: "acme", threadId: "t_1", seq: 4 }); // "acme:t_1:4"
```

A record that the Queue delivers again after the upgrade has a new key. If your Platform stored the old keys, that record does not match its stored key, and your handler can count it two times. karmi does not migrate stored keys. Deploy the upgrade when the Queue has no Usage batch that waits for a retry.
