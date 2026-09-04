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

## Agent Specs as data

An Agent Spec is plain JSON. A Platform can validate one against the Catalogue without a Scope:

```ts
import { agentSpecJsonSchema, validateAgentSpec } from "@karmi/core";

const { ok, issues, normalized } = validateAgentSpec(json, karmi.catalogue);
// issues: [{ severity: "error", code: "ref.tool.unknown", path: "/tools/0/name", message: 'Unknown Tool "wether".' }]
```

Errors block; warnings never do. `agentSpecJsonSchema` is the Spec's JSON Schema, for editors. The Scope-resolved layer (ceilings, provider profiles, delegate Agents) lands with the ScopeConfig DO.

Start from [`wrangler.baseline.jsonc`](./wrangler.baseline.jsonc): `compatibility_date >= 2026-08-04` is the one hard requirement; karmi refuses to start below it.

## Providers

A Provider is an adapter registered by name; a Provider profile in the Scope config (or `defaults`) picks one and says how to reach it — gateway, `compaction: harness | provider`, `providerOptions`, `headers`. Credentials are always references, never values. The seam is small and plain JSON: `stream(request, { fetch, signal })` yields `ProviderEvent`s, `capabilities(modelId)` reports what media a model takes, and `prepareMessages()` applies the cross-provider replay rules to a transcript before any adapter sees it.

## Testing

`@karmi/core/testing` ships `fakeProvider`, a scripted Provider that is registered like any other:

```ts
import { fakeProvider, reply } from "@karmi/core/testing";

const provider = fakeProvider(({ request, index }) => (index === 0 ? [reply.reasoning("…"), reply.toolCall("weather", { city: "Oslo" })] : "Sunny in Oslo"));
createKarmi({ catalogue, providers: { fake: provider }, defaults: { providers: { default: { adapter: "fake", models: ["*"] } } } });
// later: expect(provider.requests[1].messages).toMatchSnapshot();
```

Wrap a real adapter in `recordingProvider(real)` once, keep its `toJSONL()`, and replay it with `fakeProvider.fromRecording(jsonl)`.

Tests run in workerd under `@cloudflare/vitest-plugin` against one shared `test/wrangler.jsonc`:

```sh
pnpm typecheck && pnpm lint && pnpm test
```
