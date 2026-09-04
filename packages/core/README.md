# @karmi/core

A code-first TypeScript framework for building agent harnesses that run natively on Cloudflare.

```ts
// src/worker.ts
import { createKarmi, defineAgent, defineTool } from "@karmi/core";
import { z } from "zod";

const weather = defineTool({
  name: "weather",
  description: "Current weather for a city",
  input: z.object({ city: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `Sunny in ${city}`,
});

const karmi = createKarmi({
  catalogue: {
    tools: [weather],
    agents: [defineAgent({ agentId: "concierge", name: "Concierge", instructions: [{ text: "Help the guest." }], model: { id: "anthropic/claude-sonnet-5" }, tools: ["weather"] })],
  },
});

export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;
export default { queue: karmi.queueHandler };
```

Start from [`wrangler.baseline.jsonc`](./wrangler.baseline.jsonc): `compatibility_date >= 2026-08-04` is the one hard requirement; karmi refuses to start below it.

## Testing

Tests run in workerd under `@cloudflare/vitest-plugin` against one shared `test/wrangler.jsonc`:

```sh
pnpm typecheck && pnpm lint && pnpm test
```
