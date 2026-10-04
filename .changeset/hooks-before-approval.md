---
"@karmi/core": minor
---

Changed the order in which the Harness decides a Tool call. The `before-tool` Hooks now run before the Harness requests an Approval. Before this change, they ran after the answer. The new order is:

1. A `deny` from the Permission Policy.
2. Validation of the input against the schema of the Tool.
3. The `before-tool` Hooks.
4. The Approval, when the Permission Policy gives `ask`.
5. The run of the Tool.

These are the changes that you can see:

- An asked call with invalid input gets the `Invalid input` error result. The Harness does not request an Approval for it.
- An asked call that a `before-tool` Hook refuses gets an error result with the reason of the Hook. The Harness does not request an Approval for it. If no asked call of a batch remains, the Turn does not park.
- The `input` of the `approval.requested` event is the input that the Tool runs with. It includes a change that a `before-tool` Hook made. The person approves that input.
- A `before-tool` Hook runs one time for each call. It also runs for a call that a person then denies. It does not run again after the answer, a timeout or a resume.
- A `before-tool` Hook gets input that is valid against the schema of the Tool. Invalid input gets its error result before the Hooks run.
- An asked call to a Tool that is not loaded gets its error result and no Approval.

A Permission Policy rule cannot use the Scope, the User or the input. To refuse a call by one of these, write a `before-tool` Hook. A person is then not asked about a call that the Hook refuses.

If a `before-tool` Hook has an effect that must occur only for a call that runs, move that effect to an `after-tool` Hook or to the Tool. An example is an audit record.

Before:

```ts
import { defineHook } from "@karmi/core";

export const audit = defineHook({
  name: "audit",
  point: "before-tool",
  run: ({ call, logger }) => logger.info("Tool call", { tool: call.name }),
});
```

After:

```ts
import { defineHook } from "@karmi/core";

export const audit = defineHook({
  name: "audit",
  point: "after-tool",
  run: ({ call, result, logger }) => {
    if (!result.isError) logger.info("Tool call", { tool: call.name });
  },
});
```

An Approval that waits for an answer during the upgrade is from the old order. The `before-tool` Hooks do not run for that call. Answer or cancel the pending Approvals before you upgrade if a Hook must see each call.
