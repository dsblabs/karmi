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

## Recovery and time

A Thread resumes from its persisted event log after eviction. It retries the unfinished Step, keeps completed Tool results, and repeats an unfinished Tool only when `readOnlyHint` or `idempotentHint` is true. Other unfinished calls produce an error with `interrupted: { attempt }`; `after-tool` Hooks receive that metadata too. Tool `callId`s remain stable, and `before-tool` Hooks do not repeat for logged calls.

Each Step allows three attempts. Classified platform failures (code-update resets or retryable Durable Object errors) preserve the attempt budget. The watchdog runs on the Durable Object's shared alarm and keeps live calls alive.

## Parking

A Turn can wait without holding a Worker. A Permission Policy `ask` runs the allowed calls of the batch first, then logs one `approval.requested { kind: "tool" }` per asked call and parks the Turn (`turn.paused { reason: "approval" }`). `thread.approve(seq, { decision, reason?, remember?, by? })` answers the request at that `seq`; a deny becomes an `isError` Tool result the model sees next, `remember: true` allows that Tool by name for the rest of the Thread, and a second answer is rejected. Unanswered requests expire to a deny after `approvals.timeout` (24 h by default, capped by the Scope ceiling) on the same alarm.

Every Turn runs under a budget of Steps, wall time and tokens: the `longRunning` Capability's `{ maxSteps, maxWallMs, maxTokens }` under the Scope ceiling, or small defaults without the grant. Exhaustion parks for an `approval.requested { kind: "continue", budget }`; an allow opens a fresh window, a deny or timeout ends the Turn with `turn.completed { stopReason: "budget" }`. `thread.status()` reports `budget`, `paused` and `pendingApprovals` while a Turn is in flight.

A Tool may return `{ pending: jobId }` to hand its call to a Job; the Step parks (`turn.paused { reason: "job" }`) until `thread.jobs.complete(jobId, result)`, `fail(jobId, message)` or `cancel(jobId)` reports back, with `thread.jobs.progress(jobId, content)` logged along the way.

While a Turn runs or is parked, further `send()`s coalesce in order into the one next Turn; `send(input, { steer: true })` joins the running Turn at its next batch boundary instead. `thread.cancel()` ends the Turn as `turn.failed { reason: "cancelled" }`, answering its pending asks with `source: "cancel"`; queued inputs still run. A Scope suspension parks at the next Step boundary; the next input or `thread.resume()` continues it. In tests, `send()` resolves at the Turn's end or park, and `thread.approve` or `clock.advance` continues it.

Core reads wall time through `Clock.now()`. `createKarmi({ clock })` accepts an implementation; the default uses `Date.now()`. The test kit supplies an advancing clock:

```ts
// Export these from the test Worker, alongside its Durable Object classes.
export const { karmi, scope, provider, clock } = createTestKarmi(catalogue);
export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;

// In a test, after evictDurableObject(stub):
await clock.advance("24h"); // Also fires due alarms through cloudflare:test.
```

`advance()` accepts milliseconds or durations with `ms`, `s`, `m`, `h`, or `d` suffixes. It moves the clock forward and dispatches due alarms; live or recovered Steps continue in-process, so observe completion through the Thread's event stream.
