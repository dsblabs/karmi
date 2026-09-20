# Contributing to karmi

This file tells you how to set up the repository, run the checks and open a pull request. The principles and rules for code, comments, prose and docs upkeep are in [`AGENTS.md`](./AGENTS.md). Read that file before you change code or docs.

## Setup

You need Node.js 22 or later and the pnpm version in the `packageManager` field of `package.json`.

Install [Vale](https://vale.sh/docs/install) for the prose check. Install [lychee](https://github.com/lycheeverse/lychee#installation) for the link check.

Clone the repository and install the dependencies:

```sh
git clone https://github.com/dsblabs/karmi.git
cd karmi
pnpm install
```

## Checks

CI runs these commands on each pull request. Run them before you push. The commands build the packages that they need.

| Command             | What it checks                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `pnpm typecheck`    | The types in all packages.                                                |
| `pnpm lint`         | The lint rules in all packages.                                           |
| `pnpm format:check` | The code format. Run `pnpm format` to fix the format.                     |
| `pnpm test`         | The tests in all packages.                                                |
| `pnpm docs:api`     | The API reference build. It fails when an export has a JSDoc problem.     |
| `pnpm docs:links`   | Checks the relative links and anchors in Markdown files.                  |
| `pnpm docs:llms`    | Writes `llms.txt` from the guide index. CI fails when the file is old.    |
| `pnpm docs:samples` | Checks the types in each `ts` code block in the guide.                    |
| `pnpm prose:check`  | The writing rules in the docs. The rules are in `docs/agents/writing.md`. |

To run one command for one package, add a filter. This command runs the tests of `@karmi/core` only:

```sh
pnpm --filter @karmi/core test
```

## Changesets

A change that a user can see needs a changeset. A change that users cannot see gets no changeset. Run this command and select the packages and the version type:

```sh
pnpm changeset
```

All `@karmi/*` packages and `create-karmi` get the same version number. The rules for changeset text are in [`docs/agents/writing.md`](./docs/agents/writing.md#changeset-text).

## Pull requests

1. Find or open an issue for the work. The issue tracker rules are in [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).
2. Create a branch from `main`.
3. Make the change. Update the docs that the "Docs upkeep" table in [`AGENTS.md`](./AGENTS.md#docs-upkeep) lists for the change.
4. Add a changeset if a user can see the change.
5. Run the checks.
6. Open a pull request against `main`. Start the title with a type, for example `fix:`, `feat:` or `docs:`.
7. Fix each failed CI check in the same pull request. Do not add an ignore marker to make a check pass.

## Where things live

| Path                                                                                   | Contents                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`AGENTS.md`](./AGENTS.md)                                                             | The principles and rules for all contributors.                     |
| [`CONTEXT.md`](./CONTEXT.md)                                                           | The glossary of karmi terms.                                       |
| [`docs/adr/`](./docs/adr)                                                              | The architecture decision records.                                 |
| [`docs/agents/`](./docs/agents)                                                        | The rules for writing, comments, TypeScript and the issue tracker. |
| [`docs/guide/`](./docs/guide)                                                          | The user docs for the public API.                                  |
| [`packages/core/INTERNALS.md`](./packages/core/INTERNALS.md)                           | The internals of `@karmi/core`.                                    |
| [`packages/http/INTERNALS.md`](./packages/http/INTERNALS.md)                           | The internals of `@karmi/http`.                                    |
| [`packages/sandbox-container/INTERNALS.md`](./packages/sandbox-container/INTERNALS.md) | The internals of `@karmi/sandbox-container`.                       |
