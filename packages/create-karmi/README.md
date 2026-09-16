# create-karmi

Scaffolds a karmi project: the wrangler baseline, a sample Agent and Tool, the
REST/SSE/WebSocket routes, a cron and a Queue consumer written over the Thread
API, a test suite on `createTestKarmi`, and CI.

```sh
pnpm create karmi my-agent
cd my-agent
pnpm install
pnpm typecheck && pnpm test
```

`pnpm test` runs `karmi doctor` before `vitest run`, so a misconfigured Worker
fails before the suite does. Nothing else happens at scaffold time: no install,
no git, no network.

| Option          | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| `<directory>`   | Where the project is written. It is created when absent and must be empty.        |
| `--name <name>` | The package, Worker, Queue and bucket name. Defaults to the directory's name.     |

The template itself lives in [`template/`](./template) and is a workspace package
of this repository, so every karmi release typechecks, doctors and tests the
thing a developer is about to be handed.

`scaffold()` is exported too, for a tool that generates projects of its own.
