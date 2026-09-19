# AGENTS.md

## Core principles

- The goal is a working serverless agentic harness + framework, shipped as fast as possible. It is not a demonstration of what we can build ourselves. Use existing harnesses, products, and frameworks wherever they fit.
- I like ambitious ideas, simple systems, software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.
- For the public API surface of the product, prefer simplicity over anything. The developer using this framework should have the world's best and most intuitive developer experience.
- "Measure twice, cut once" and YAGNI. Fight scope creep. Honor the dev's intent in a minimal and realistic fashion.
- Always design for performance. Write code that is efficient in latency, memory, and cost, and pick data structures and access patterns that stay efficient at scale.
- Every exported symbol carries a JSDoc block that says what it is or does in one plain sentence, then only what a caller needs: defaults, failure modes, what it never does. Internal code is commented only where the code cannot say why. Every comment is a full sentence a newcomer can read without knowing the system; a riddle, slogan or metaphor is rewritten or deleted. Details: `docs/agents/comments.md`.
- All prose follows `docs/agents/writing.md`: docs, READMEs, JSDoc, comments, issue answers and changeset text. It is based on ASD-STE100 Simplified Technical English.

## TypeScript

The formatter, linter and type checker enforce the mechanical rules. Run all three before you finish, and never add to a lint suppressions file. Beyond the tooling:

- Narrow types instead of asserting them.
- Decode external or stored data in one function per shape.
- Load state once and pass it down. Never mix a stale copy with a fresh read.
- Keep one source of truth. Extract shared logic instead of mirroring it, and derive types from schemas.
- Use one error style per layer: return results or throw, not both.
- Keep pure logic apart from I/O.

Details, including persistence schema, ids and tests: `docs/agents/typescript.md`.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `dsblabs/karmi` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
