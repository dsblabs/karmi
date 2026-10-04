---
"@karmi/core": minor
---

Added the `approvals.remember` setting to the Agent Spec. It is a boolean, and the default is `true`.

With `approvals.remember: false`, the Thread ignores `remember` on an Approval answer. The Thread does not reject the answer. An answer `{ decision: "allow", remember: true }` allows that one call. The `approval.resolved` event has no `remember` field, and the next call of the same Tool asks again. This is the same for `thread.approve`, the HTTP route and the socket.

The setting applies from the next Turn that reads the Agent Spec. While it is `false`, an allow that the Thread remembered before has no effect. For an Approval of a delegated child, the Agent Spec of the child decides.

This sample defines an Agent that asks before each call of `book`:

```ts
import { defineAgent } from "@karmi/core";

export const agent = defineAgent({
  agentId: "booking",
  name: "Booking",
  instructions: [{ text: "Ask before each booking." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["book"],
  approvals: { remember: false },
});
```
