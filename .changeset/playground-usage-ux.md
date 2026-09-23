---
"@karmi/core": patch
---

Changed the Playground scenario "Usage records, costs and logs":

- Each Usage record shows its key, its model and its tokens.
- The sample UsageHandler skips a record that it stored before, as a handler that deduplicates by `usageKey` does. The card shows each delivery as `stored`, `duplicate, skipped` or `failed, the Queue retries`.
- The Logs card shows each log line with its level, its message and its fields.
- Fixed log lines and deliveries that got lost when two of them arrived at the same time.

Fixed the Playground page after the Schedules scenario. A view that the operator opened less than one second after a reset of that scenario did not show the events of its Thread.
