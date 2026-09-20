# @karmi/core

`@karmi/core` is the main package of karmi. karmi is a TypeScript framework for agent products that serve many customers. You write Agents and Tools in code. karmi runs them on Cloudflare Workers, and you operate no servers.

The package gives you these things:

- A parked Turn uses no Worker time. A Turn parks for an Approval, for its budget or for a Job.
- A Thread continues from its event log after Cloudflare stops its Durable Object. You write no code for this.
- Every Agent, Thread, Memory and secret resolves under a Scope. karmi has no operation that crosses Scopes.
- An Agent Spec is plain JSON. Your product can store one for a Scope at runtime, with no deploy.
- A Permission Policy resolves each Tool call to allow, ask or deny. Ask stops the Turn until a person answers.
- The Test kit at `@karmi/core/testing` runs your Catalogue in workerd against a scripted Provider.
- `karmi doctor` finds configuration that stops a Deployment before `wrangler deploy` does.

karmi runs only on Cloudflare Workers. It does not authenticate, and it has no sign-up or billing. [The karmi README](https://github.com/dsblabs/karmi#readme) gives each reason in full.

Install the package:

```sh
pnpm add @karmi/core
```

Read these pages of the karmi guide:

- [Getting started](https://github.com/dsblabs/karmi/blob/main/docs/guide/01-getting-started.md) creates a project, runs its tests and deploys it.
- [The guide index](https://github.com/dsblabs/karmi/blob/main/docs/guide/README.md) lists all the pages.
- [The glossary](https://github.com/dsblabs/karmi/blob/main/CONTEXT.md) defines the terms.

The API reference is not in the repository. To build it, run `pnpm docs:api` in a clone of [the karmi repository](https://github.com/dsblabs/karmi).

For contributors, [`INTERNALS.md`](https://github.com/dsblabs/karmi/blob/main/packages/core/INTERNALS.md) describes the structure of the package.
