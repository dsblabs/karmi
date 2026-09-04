# AGENTS.md

## Core principles

- The goal is a working serverless agentic harness + framework, shipped as fast as possible. It is not a showcase of what we can build ourselves. Use existing harnesses, products, and frameworks wherever they fit.
- I like ambitious ideas, simple systems, software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.
- For the public API surface of the product, prefer simplicity over anything. The developer using this framework should have the world's best and most intuitive developer experience.
- "Measure twice, cut once" and YAGNI. Fight scope creep. Honor the dev's intent in a minimal and realistic fashion.
- Always design for performance. Write code that is efficient in latency, memory, and cost, and pick data structures and access patterns that stay efficient at scale.
- Comments explain intent, not code. The code is its own source of truth. A comment on a function or class saying why it exists is welcome; a comment restating what the next line does is not.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `dsblabs/karmi` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
