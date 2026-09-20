# create-karmi

`create-karmi` creates a karmi project. The project is a full Deployment that you can test and deploy. It contains these parts:

- One sample Tool and one sample Agent.
- REST, Server-Sent Events and WebSocket routes.
- A cron and a Queue consumer.
- A test suite that runs the full Deployment with a scripted model.

`create-karmi` only writes the project files. It does not install packages, run git or use the network.

Run the package:

```sh
pnpm create karmi my-agent
```

Read these pages of the karmi guide:

- [Getting started](https://github.com/dsblabs/karmi/blob/main/docs/guide/01-getting-started.md) describes the options, the project files and the deploy.
- [Testing](https://github.com/dsblabs/karmi/blob/main/docs/guide/13-testing.md) describes the tests of the project.
