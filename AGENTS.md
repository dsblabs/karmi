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

## Docs upkeep

A PR that makes one of these changes must also update the listed docs. A reviewer rejects a PR that does not.

| Change | Docs to update in the same PR |
|---|---|
| A public export: its name, signature, options or types | Its JSDoc, the guide page for it and a changeset |
| Behaviour that a user can see, with no API change | The guide page for it and a changeset |
| Configuration, bindings, the CLI or `karmi doctor` | The guide page for it, the `create-karmi` template if it uses the change, and a changeset |
| The `create-karmi` template | The template docs and `docs/guide/01-getting-started.md` |
| Internals: data flow, invariants or test layout | The `INTERNALS.md` of the package |
| A domain term | `CONTEXT.md` |
| A decision that is hard to reverse | A new ADR in `docs/adr/` |

- A changeset tells users what changed. The guide and the JSDoc tell how it works now. One does not replace the other.
- A change that users cannot see gets no changeset. Do not add an empty one.
- CI checks the mechanical part: prose lint, the API reference build, relative links and code sample types. A reviewer checks that a change users can see has a changeset.
- The PR author fixes a failed check in the same PR.
- Do not add an ignore marker to make a check pass. The only exception is the list of intentionally unexported types in the TypeDoc configuration.
- If a code sample does not compile on purpose, do not tag it `ts`. Use `text`.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `dsblabs/karmi` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
