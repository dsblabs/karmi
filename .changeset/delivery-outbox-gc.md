---
"@karmi/core": patch
---

Changed a `delivery` Queue message to carry the Deliverer route with the event range. A retry still reaches the Deliverer after the Thread drops that range from its Outbox.
