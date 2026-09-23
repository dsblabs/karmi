---
"@karmi/core": patch
---

Changed the Playground scenario "Usage records, costs and logs":

- The Usage records card shows the Scope, the Agent, the User, the Thread and the model one time, with the sum of the reported costs. A table then has one row for each record, with its tokens and its cost.
- The UsageHandler card shows when it waits for the Queue, and it updates when the batch arrives. Before, it showed a batch only after the next Turn.
- The first suggested prompt is a question that the Agent can answer. The Agent does not know its spend, and the Usage records card shows it.
- Fixed deliveries and log lines of the Thread before a reset that showed after the reset.
