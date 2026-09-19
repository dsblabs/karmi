# Domain docs

This file tells the engineering skills how to use the domain docs of this repo when they explore the codebase.

## Files to read before you explore

- `CONTEXT.md` at the repo root.
- `CONTEXT-MAP.md` at the repo root, if it exists. It lists one `CONTEXT.md` for each context. Read each one that applies to the topic.
- `docs/adr/`. Read the ADRs that apply to the area of your work. In a repo with many contexts, also read `src/<context>/docs/adr/` for the decisions of one context.

If one of these files does not exist, continue and do not report it. Do not recommend that someone creates the file. The `/domain-modeling` skill creates these files when a session decides a term or a decision. The `/grill-with-docs` and `/improve-codebase-architecture` skills call that skill.

## File structure

Most repos have one context:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

A repo with many contexts has a `CONTEXT-MAP.md` at the root:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the terms of the glossary

Your output can name a domain concept in an issue title, a refactor proposal, a hypothesis or a test name. Use the term that `CONTEXT.md` defines. Do not use a synonym that the glossary tells you to avoid.

If the glossary does not have the concept that you need, there are two possible causes:

- You made a word that the project does not use. Think again about the word.
- The glossary has a gap. Record the gap for `/domain-modeling`.

## Report ADR conflicts

If your output contradicts an existing ADR, tell the reader. Do not ignore the ADR without a note. Example:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
