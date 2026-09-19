---
title: Deployment
---

# Deployment

A karmi Deployment is one Cloudflare Worker. [Getting started](./01-getting-started.md#deploy) gives the deploy steps for a new project. This page describes the bindings, the container sandbox, and how a Thread recovers.

## The wrangler baseline

`@karmi/core` publishes its Wrangler configuration as `@karmi/core/wrangler.baseline.jsonc`. A project from `create-karmi` starts with the same configuration. This extract shows the parts that karmi reads:

```jsonc
{
  "compatibility_date": "2026-08-04",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "durable_objects": {
    "bindings": [
      { "name": "KARMI_THREADS", "class_name": "ThreadDO" },
      { "name": "KARMI_SCOPES", "class_name": "ScopeConfigDO" },
      { "name": "KARMI_MEMORY", "class_name": "MemoryDO" },
      { "name": "KARMI_KNOWLEDGE", "class_name": "KnowledgeDO" },
    ],
  },
  "migrations": [
    { "tag": "karmi-v1", "new_sqlite_classes": ["ThreadDO", "ScopeConfigDO"] },
    { "tag": "karmi-v2", "new_sqlite_classes": ["MemoryDO"] },
    { "tag": "karmi-v3", "new_sqlite_classes": ["KnowledgeDO"] },
  ],
  "r2_buckets": [{ "binding": "KARMI_MEDIA", "bucket_name": "my-agent-media" }],
  "queues": {
    "producers": [{ "binding": "KARMI_QUEUE", "queue": "my-agent-queue" }],
    "consumers": [{ "queue": "my-agent-queue", "max_retries": 3, "dead_letter_queue": "my-agent-dlq" }],
  },
  "observability": { "enabled": true },
}
```

- karmi does not start with a `compatibility_date` before `2026-08-04`.
- The flag `global_fetch_strictly_public` stops a request from the Worker to a private address. We recommend it.
- The Worker entry must export each Durable Object class with the name that the binding gives.

## Bindings

karmi reads these names from the `env` of the Worker. The first three are mandatory.

| Binding           | Type                     | Purpose                                                   |
| ----------------- | ------------------------ | --------------------------------------------------------- |
| `KARMI_THREADS`   | Durable Object namespace | The Threads.                                              |
| `KARMI_SCOPES`    | Durable Object namespace | The configuration of each Scope.                          |
| `KARMI_MEMORY`    | Durable Object namespace | [Memory](./09-memory.md).                                 |
| `KARMI_KNOWLEDGE` | Durable Object namespace | [Knowledge](./10-knowledge.md).                           |
| `KARMI_MEDIA`     | R2 bucket                | Media and large Tool output.                              |
| `KARMI_QUEUE`     | Queue producer           | Offline delivery and usage records.                       |
| `KARMI_LOADER`    | Worker Loader            | [Isolate Scripts](./07-sandbox.md#isolate-scripts).       |
| `KARMI_SANDBOX`   | Durable Object namespace | [Container Scripts](./07-sandbox.md#container-scripts).   |
| `KARMI_VECTORIZE` | Vectorize index          | Vector retrieval for [Knowledge](./10-knowledge.md).      |
| `KARMI_AI`        | Workers AI               | Embeddings for [Knowledge](./10-knowledge.md).            |
| `KARMI_KEYRING`   | Secret                   | The keys that encrypt [credentials](./12-credentials.md). |

Set `KARMI_KEYRING` with `wrangler secret put`. Do not write it in the Wrangler configuration.

The consumer of the karmi Queue must call `karmi.queueHandler`. If the Worker also consumes your own Queues, use `batch.queue` to find the correct handler.

[Doctor](./15-doctor.md) checks the bindings, the exports and the migrations before you deploy.

### Other binding names

If the Worker cannot use these names, give `createKarmi` a `bindings` function. It maps your `env` to the karmi names. This sample uses two namespaces that have other names:

```ts
import { createKarmi, type CatalogueInput } from "@karmi/core";

interface Env {
  THREADS: DurableObjectNamespace;
  SCOPES: DurableObjectNamespace;
  MEMORY: DurableObjectNamespace;
}

export function makeKarmi(catalogue: CatalogueInput) {
  return createKarmi<Env>({
    catalogue,
    bindings: (env) => ({ KARMI_THREADS: env.THREADS, KARMI_SCOPES: env.SCOPES, KARMI_MEMORY: env.MEMORY }),
  });
}
```

`karmi doctor` checks the fixed names only.

## The container sandbox

Do these steps only if an Agent uses [container Scripts](./07-sandbox.md#container-scripts).

1. Copy the `Dockerfile` of `@karmi/sandbox-container` into your project. The package exports it as `@karmi/sandbox-container/Dockerfile`.

2. Add the binding, a migration and the container to the Wrangler configuration. Keep the entries that the configuration has already:

   ```jsonc
   {
     "durable_objects": {
       "bindings": [{ "name": "KARMI_SANDBOX", "class_name": "KarmiSandbox" }],
     },
     "migrations": [{ "tag": "karmi-sandbox-v1", "new_sqlite_classes": ["KarmiSandbox"] }],
     "containers": [{ "class_name": "KarmiSandbox", "image": "./Dockerfile", "max_instances": 10 }],
   }
   ```

3. Export `KarmiSandbox` and `ContainerProxy` from the Worker entry, and give `createKarmi` the image:

   ```ts
   import { createKarmi, defineAgent } from "@karmi/core";

   const reportAgent = defineAgent({
     agentId: "reporter",
     name: "Reporter",
     instructions: [{ text: "Build the weekly sales report." }],
     model: { id: "anthropic/claude-sonnet-5" },
     capabilities: { scripts: { tier: "container" } },
   });

   const karmi = createKarmi({
     catalogue: { agents: [reportAgent] },
     sandbox: { image: "./Dockerfile" },
   });

   export { KarmiSandbox, ContainerProxy } from "@karmi/core";
   export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
   export default { queue: karmi.queueHandler };
   ```

`sandbox.image` must be the same as the `image` in the Wrangler configuration. Wrangler builds the image and selects it. `karmi doctor` reports the binding and the image.

`ContainerProxy` adds a line to stderr for each denied hostname.

The image extends the Cloudflare Sandbox SDK image `0.12.9-python`. Keep the version of the SDK package the same as the version of the image. The image is for AMD64. An ARM computer needs AMD64 emulation to build it.

The package tests do not use a real container. Test the network rules and the recovery of a process in a real Cloudflare deployment of your account. The [Cloudflare outbound traffic documentation](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) describes how the Worker intercepts requests.

## Recovery

Cloudflare can stop a Durable Object at any time, for example for a code update. A Thread then continues from its stored event log. You do not write code for this.

- The Thread tries the Step that did not finish again. It keeps the results of the Tool calls that finished.
- It runs a Tool call that did not finish again only if the Tool has `readOnlyHint` or `idempotentHint`. [Tools](./03-tools.md) describes the annotations.
- Each other call that did not finish gets an error result with `interrupted: { attempt }`. The after-tool Hooks get the same data.
- The `callId` of a Tool call does not change. The before-tool Hooks do not run again for a call that is in the log.

Each Step has three attempts. A failure of the platform, for example a code update or a Durable Object error that Cloudflare marks as retryable, does not use an attempt.

Thus, set `idempotentHint` on each Tool that is safe to run two times. Without it, the model gets the error and decides what to do.

## Time

Each time in karmi is a number of milliseconds since the Unix epoch. The Harness reads the time from one `Clock`. The default is `wallClock`, which reads `Date.now()`. The `clock` option of `createKarmi` replaces it. [Testing](./13-testing.md) describes the clock of the Test kit.

Approvals, Jobs, [Schedules](./08-schedules.md) and the recovery of a Turn all use the alarm of the Thread Durable Object. They need no cron and no other binding.

Go back to the [guide index](./README.md).
