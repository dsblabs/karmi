# 5. Durable Objects own inlined Drizzle migrations

Date: 2026-09-18. Status: accepted. Decided in [Move all Durable Object storage to Drizzle ORM](https://github.com/dsblabs/karmi/issues/112).

## Context

Durable Object classes created tables with raw SQL and could probe the live schema on every start. That
made schema changes manual, spread persistence definitions across runtime modules and left no durable
record of which changes an object had applied. Importing generated `.sql` files at runtime would also make
consuming Workers add a Wrangler module rule that the package otherwise does not need.

## Decision

Each Durable Object class owns one Drizzle schema and one migration folder with its own journal. The
schema is the source of truth and `pnpm db:generate` runs Drizzle Kit for every class. It then commits the
journal and SQL again as a TypeScript module, so runtime code imports no `.sql` file.

Drizzle remains an implementation detail: no exported API mentions its types. Migrations run under
`blockConcurrencyWhile` when an object starts. Features that SQLite exposes outside ordinary tables,
including FTS5 virtual tables and their triggers, use custom SQL migrations in the same journal.

## Consequences

- A schema change and its generated migration module land together, and a test rejects a stale module.
- Each Durable Object advances independently and applies every numbered migration at most once.
- Consuming Workers need no new Wrangler rule or compatibility setting.
- A merged migration is immutable; later corrections are new migrations.
