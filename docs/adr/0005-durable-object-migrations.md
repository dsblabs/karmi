# 5. Durable Objects own inlined Drizzle migrations

Date: 2026-09-18. Status: accepted. Decided in [Move all Durable Object storage to Drizzle ORM](https://github.com/dsblabs/karmi/issues/112).

## Context

Durable Object classes created tables with raw SQL and could probe the live schema on every start. That
made schema changes manual, spread persistence definitions across runtime modules and left no durable
record of which changes an object had applied. Importing generated `.sql` files at runtime would also make
consuming Workers add a Wrangler module rule that the package otherwise does not need.

## Decision

Each Durable Object class owns one Drizzle schema and one migration folder with its own journal. A Durable
Object runs exactly that one journal because Drizzle's Durable SQLite migrator records one high-water mark
per storage in `__drizzle_migrations`. Tables used by more than one class are schema fragments imported by
each host schema, not independent journals.

The schema is the source of truth and `pnpm db:generate` runs Drizzle Kit for every class. It then commits
the journal and SQL again as a TypeScript module, so runtime code imports no `.sql` file.

Drizzle remains an implementation detail: no exported API mentions its types. Migrations run under
`blockConcurrencyWhile` when an object starts. Features that SQLite exposes outside ordinary tables,
including FTS5 virtual tables and their triggers, use custom SQL migrations in the same journal.

## Consequences

- A schema change and its generated migration module land together, and a test rejects a stale module.
- Each Durable Object advances independently and applies every numbered migration at most once.
- Consuming Workers need no new Wrangler rule or compatibility setting.
- Before the first deployment, an issue may explicitly permit regenerating an initial migration. Once
  persisted storage can exist, a merged migration is immutable and later corrections are new migrations.

## Rejected options

- Running two journals with an interleaving guard leaves every future migration coupled to the timestamp
  ordering of both journals.
- Owning a per-journal migrator adds machinery solely to work around Drizzle's single high-water mark.

## Amendment 2026-10-01: an upgrade is one-way during `0.x`

Decided in [Record that a karmi upgrade is one-way during 0.x](https://github.com/dsblabs/karmi/issues/237).

### Decision

karmi does not promise that the release before can run on storage that a new release wrote. This applies
to all `0.x` releases. The maintainers decide the promise again before `1.0`.

A changeset for a change that alters stored data starts a line with the phrase `Stored data change:`.
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#stored-data-changes) defines when a changeset must have it. An
upgrade to a release with that line is one-way: the consumer cannot roll back to the release before. An
upgrade to a release with no such line keeps a normal rollback.

### Reasons

- The SQL schema is only one part of the stored data. A new Thread event type, a new field in a stored
  shape or a new Queue message shape can also break an older release.
- The event vocabulary changes in most releases, so most releases can write data that an older release
  cannot read.
- A Cloudflare rollback does not change the stored data. Cloudflare warns that the code of an older
  version can fail when the structure of the data changed
  ([Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#rolling-back-from-a-split-deployment)).
- Cloudflare refuses a rollback across a deployment that changed the lifecycle of a Durable Object class
  ([Rollbacks, Bindings](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)).
  A new entry in the `migrations` array of the Wrangler configuration is such a change. We conclude that
  a karmi release that adds a Durable Object class is one-way on the platform also.

### Rejected options

- The full promise: each release can run on storage that the next release wrote. Each change to a stored
  shape then takes two releases, one that reads the new shape and one that writes it. That cost is too
  high while the event vocabulary changes in most releases.
- The schema-only promise: only the SQL schema stays compatible with the release before. This promise is
  misleading. A consumer reads "safe" and rolls back, and then a Thread with one new event type fails.
