---
"@karmi/core": patch
"@karmi/http": patch
"create-karmi": patch
---

Add `create-karmi`, which scaffolds a project with the wrangler baseline, a sample Agent and Tool, the HTTP routes, a cron and a Queue consumer over the Thread API, a test suite on `createTestKarmi` and CI. The template is a workspace package, so every release typechecks, doctors and tests it. `karmi doctor` grows from the Vectorize check into the full pre-deploy check: the compatibility date and flags, the `KARMI_*` bindings, Durable Object re-exports and SQLite migrations, which Script tiers are reachable, an AI Gateway in front of deferred Tools, the MCP pre-registration checklist with the exact callback URL, and Agent Specs that name Catalogue items nobody defines. Every check is exported as a function.
