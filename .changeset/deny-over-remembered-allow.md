---
"@karmi/core": minor
---

Changed the precedence of a remembered allow in the Permission Policy. A remembered allow now changes only the effect `ask` to `allow`. Before this change, a remembered allow won over each rule.

When the first matching rule for a Tool has the effect `deny`, the Harness denies the Tool. This is also true when the Thread has a remembered allow for the name of the Tool. Thus a `deny` rule that a Scope or a Deployment adds later stops the Tool in each Thread.

If a Thread must use a Tool after an allow, make sure that no `deny` rule matches the Tool first. Put a rule with the effect `ask` before the `deny` rule.

Before, the remembered allow of `book` won over the `deny` rule:

```ts
import type { PolicyRule } from "@karmi/core";

export const policy: PolicyRule[] = [{ match: { tool: "*" }, effect: "deny" }];
```

After, the `ask` rule matches `book` first, and a remembered allow applies to it:

```ts
import type { PolicyRule } from "@karmi/core";

export const policy: PolicyRule[] = [
  { match: { tool: "book" }, effect: "ask" },
  { match: { tool: "*" }, effect: "deny" },
];
```
