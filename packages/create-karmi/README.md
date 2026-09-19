# create-karmi

`create-karmi` creates a karmi project. The project contains these parts:

- The wrangler baseline.
- A sample Agent and a sample Tool.
- The REST, SSE and WebSocket routes.
- A cron and a Queue consumer that use the Thread API.
- A test suite that uses `createTestKarmi`.
- CI.

Run these commands to create a project and test it:

```sh
pnpm create karmi my-agent
cd my-agent
pnpm install
pnpm typecheck && pnpm test
```

`pnpm test` runs `karmi doctor` before `vitest run`. Thus a Worker with an incorrect configuration fails before the suite starts. `create-karmi` only writes the project files. It does not install packages, run git or use the network.

| Option          | Description                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| `<directory>`   | The project directory. `create-karmi` creates it if necessary. It must be empty.      |
| `--name <name>` | The name of the package, Worker, Queue and bucket. The default is the directory name. |

The template is in [`template/`](./template). It is a workspace package of this repository. Thus each karmi release runs the type checker, `karmi doctor` and the tests on the template that a developer gets.

The package also exports `scaffold()`. Use it in a tool that generates its own projects.
