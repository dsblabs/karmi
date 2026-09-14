---
"@karmi/core": patch
---

Usage records and the Logger seam: every model, compact and Script Step appends `usage.recorded` with the attribution tuple, tokens, model, provider, profile, credential source and version, `serverToolCalls`, and `cost` or `gateway` only as the provider reported them; a Catalogue `usageHandler` receives batches at least once through `KARMI_QUEUE` with `usageKey(record)` (`threadId:seq`) as the idempotency key, and a failed batch retries without failing the Turn; `createKarmi({ logger })` replaces the console default, and every line carries the Scope, Agent, User, Thread and Turn with credentials redacted by value, field name and bearer pattern.
