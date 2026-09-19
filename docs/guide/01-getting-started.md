---
title: Getting started
---

# Getting started

This page creates a karmi project, tests it on your computer and deploys it to Cloudflare.

You need Node.js, `pnpm` and a Cloudflare account. You also need an Anthropic Provider credential for the sample Agent.

## Create a project

Run these commands to create a project and test it:

```sh
pnpm create karmi my-agent
cd my-agent
pnpm install
pnpm typecheck && pnpm test
```

`create-karmi` only writes the project files. It does not install packages, run git or use the network.

| Option          | Description                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| `<directory>`   | The project directory. `create-karmi` creates it if necessary. It must be empty.      |
| `--name <name>` | The name of the package, Worker, Queue and bucket. The default is the directory name. |

## The project files

| File               | Contents                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `src/catalogue.ts` | The Tools and Agents that this Deployment defines in code.                      |
| `src/worker.ts`    | `createKarmi`, the HTTP routes, the Durable Object re-exports and the handlers. |
| `src/triggers.ts`  | The cron and Queue handlers. They use the Thread API.                           |
| `wrangler.jsonc`   | The karmi wrangler baseline. `karmi doctor` checks it.                          |
| `test/worker.ts`   | The same Catalogue in `createTestKarmi`, with a scripted Provider.              |

The smallest karmi Worker has one Tool, one Agent and the Durable Object exports. This sample shows it:

```ts
import { createKarmi, defineAgent, defineTool } from "@karmi/core";
import { z } from "zod";

const weather = defineTool({
  name: "weather",
  description: "The current weather in a city",
  input: z.object({ city: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `It is sunny in ${city}.`,
});

const concierge = defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "You are a hotel concierge." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather"],
});

const karmi = createKarmi({ catalogue: { tools: [weather], agents: [concierge] } });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export default { queue: karmi.queueHandler };
```

The Worker must export the four Durable Object classes with these names. The `compatibility_date` in `wrangler.jsonc` must be `2026-08-04` or later. karmi does not start with an earlier date.

## Run the tests

`pnpm test` runs `karmi doctor` and then `vitest run`. Thus a Worker with an incorrect configuration fails before the suite starts. The suite runs the full Deployment in workerd with a scripted Provider. It makes no request to a model.

`karmi doctor` checks the project before `wrangler deploy` does. It checks the compatibility date, the `KARMI_*` bindings, and the Durable Object exports and migrations. It exits with code 1 when a check fails.

## Deploy

1. Create the Queue, its dead-letter Queue and the R2 bucket that `wrangler.jsonc` names:

   ```sh
   pnpm exec wrangler queues create my-agent-queue
   pnpm exec wrangler queues create my-agent-dlq
   pnpm exec wrangler r2 bucket create my-agent-media
   ```

2. Set the two secrets. `KARMI_KEYRING` encrypts each credential that a Scope stores. `API_TOKEN` is the bearer token that the sample `authenticate` function accepts.

   ```sh
   node -e "import('@karmi/core').then(k => console.log(k.generateKeyringKey()))" | pnpm exec wrangler secret put KARMI_KEYRING
   pnpm exec wrangler secret put API_TOKEN
   ```

3. Deploy the Worker:

   ```sh
   pnpm run deploy
   ```

4. Give the `demo` Scope its Anthropic Provider credential. Its Agents cannot run without it. Run this call in code that has the `karmi` object, for example a route that only you can call:

   ```text
   await karmi.scope("demo").credentials.put("anthropic", anthropicApiKey);
   ```

## Send a message to an Agent

These commands create a Thread, send a message and read the Thread events:

```sh
curl -X POST https://<your-worker>/threads \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"agent":"concierge"}'

curl -X POST https://<your-worker>/threads/<key>/turns \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"kind":"message","parts":[{"type":"text","text":"What is the weather in Paris?"}]}'

curl -N https://<your-worker>/threads/<key>/events \
  -H "authorization: Bearer $API_TOKEN" -H "accept: text/event-stream"
```

The first command returns the Thread `key`. Put it in the place of `<key>` in the other two commands.

Next, read [Agents](./02-agents.md).
