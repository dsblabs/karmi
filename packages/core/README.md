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
    agents: [
      defineAgent({
        agentId: "concierge",
        name: "Concierge",
        instructions: [{ text: "Help the guest." }],
        model: { id: "anthropic/claude-sonnet-5" },
        tools: ["weather"],
      }),
    ],
  },
});

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
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

A Provider is an adapter registered by name; a Provider profile in the Scope config (or `defaults`) picks one and says how to reach it — gateway, `compaction: harness | provider`, `providerOptions`, `headers`. Credentials are always references, never values. The seam is small and plain JSON: `stream(request, { fetch, signal, credentials })` yields `ProviderEvent`s, `capabilities(modelId)` reports what media a model takes, and `prepareMessages()` applies the cross-provider replay rules to a transcript before any adapter sees it.

## Credentials

A profile names its credential as `scope:<name>` (the Scope's own, BYOK) or `deployment:<name>` (yours). Values never enter a Spec, a config revision, an event or a Turn snapshot: the Thread resolves the reference through the `SecretsProvider` seam right before each model Step, hands the adapter a `SensitiveValue` (which refuses JSON, string coercion and inspection) and drops it after the call. A revocation is effective at the next Step, even mid-Turn. `step.started` records the profile, the credential's source and version, and any fallback taken.

```ts
export const karmi = createKarmi({
  catalogue,
  providers: { anthropic: anthropic() },
  credentials: { anthropic: env.ANTHROPIC_API_KEY }, // deployment:anthropic
  defaults: {
    providers: { shared: { adapter: "anthropic", credential: "deployment:anthropic" } },
  },
});

// A tenant brings its own key: write-only, stored envelope-encrypted under the Scope.
await scope.credentials.put("anthropic", tenantKey);
await scope.config.set({
  providers: {
    default: {
      adapter: "anthropic",
      credential: "scope:anthropic",
      fallback: { profile: "shared", on: ["missing", "auth"] }, // opt-in; default reasons: ["missing"]
    },
  },
});
await scope.providers.test("default", { model: "anthropic/claude-sonnet-5" }); // the explicit network check
```

The default store envelope-encrypts each credential with its own data key, wrapped by the active key of the `KARMI_KEYRING` Worker secret: `{ "active": "v2", "keys": { "v1": "<base64>", "v2": "<base64>" } }` (`generateKeyringKey()` makes one). Rotate by adding a key, making it active and running `scope.credentials.rewrap()` per Scope; old keys are decrypt-only until every Scope is rewrapped, and `revoke` deletes the wrapped key. `createKarmi({ secrets })` swaps in a Platform's own `SecretsProvider`; the test kit's `createTestKarmi` uses an in-memory one.

## Remote MCP servers

Register servers in the Scope config (or `defaults`) and reference them from a Spec as `mcp:<server>` or `mcp:<server>/<tool>`. Static auth headers are credential references, so the value lives in the credential store:

```ts
await scope.credentials.put("github", "Bearer ghp_…");
await scope.config.set({
  mcp: {
    servers: {
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        auth: { type: "static", headers: { Authorization: "scope:github" } },
        deny: ["delete_repository"],
        trustAnnotations: true, // let readOnlyHint etc. drive parallelism and Policy; off, every tool counts as destructive
      },
    },
  },
  egress: { mcpHosts: ["*.githubcopilot.com"] }, // Deployment ∩ Scope; absent means any registered server
});
await scope.agents.put({ ...spec, tools: ["mcp:github"] });
```

At Turn start the Thread takes the servers' catalogues (cached per Scope, refreshed when the server's `ttlMs` elapsed, after a `-32602`, or on `scope.mcp.refreshCatalog()`), offers the tools as `github__create_issue` and so on, and connects lazily per server through `scopedFetch` for the length of the Turn. Both the 2026-07-28 and the 2025 protocol eras are spoken; `input_required` answers become error results; binary resource content spills to media.

In tests, `fakeMcpServer({ name, tools, era? })` is a real in-process server reached through the same `scopedFetch`: `createTestKarmi(catalogue, { mcpServers: [github] })`, then register `github.url` in the Scope config. `github.calls` records every request it saw and `github.tools` can be replaced to change its catalogue.

## `karmi doctor`

`karmi doctor` checks a project before `wrangler deploy` does. It exits 1 when any
check fails; warnings and skipped checks exit 0.

```sh
pnpm exec karmi doctor
```

```
ok   compatibility: compatibility_date 2026-08-04 is at or above 2026-08-04.
ok   bindings: Every karmi binding is declared under its fixed name.
ok   durable-objects: Every bound Durable Object class is exported and migrated as SQLite.
--   capabilities: No KARMI_LOADER binding: an Agent granting capabilities.scripts { tier: "isolate" } fails.
warn mcp: Set createKarmi({ oauth: { origin } }); no OAuth server can be used without it.
```

| Check             | What it reads                | What it finds                                                                       |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `compatibility`   | `wrangler.jsonc`             | A `compatibility_date` below karmi's floor, and a missing `global_fetch_strictly_public`. |
| `bindings`        | `wrangler.jsonc`             | A missing `KARMI_*` binding, a misspelt one, a Queue with no consumer, no media bucket. |
| `durable-objects` | `wrangler.jsonc` and `main`  | A Durable Object class the entry does not re-export, or that is not a SQLite class.  |
| `capabilities`    | `wrangler.jsonc`             | Whether the isolate and container Script tiers are reachable at all.                |
| `vectorize`       | The Vectorize management API | An index whose dimensions, metric or metadata indexes do not match.                 |
| `gateway`         | The manifest                 | A Provider profile behind an AI Gateway while an Agent defers its Tools.             |
| `mcp`             | The manifest                 | An MCP server whose vendor takes only a client you register by hand.                |
| `specs`           | The manifest                 | An Agent Spec whose shape is wrong or that names a Catalogue item nobody defines.    |

The last three read what the Deployment defines in code, which a wrangler config
cannot answer. Write it as JSON and pass it with `--manifest`, or leave it at
`karmi.doctor.json`, where the doctor finds it by itself:

```json
{
  "origin": "https://agents.example.com",
  "defaults": { "providers": { "default": { "adapter": "anthropic", "gateway": { "kind": "cloudflare" } } } },
  "catalogue": { "tools": [{ "name": "weather" }] },
  "specs": { "agents/concierge.json": { "agentId": "concierge", "name": "Concierge", "instructions": [], "model": { "id": "anthropic/claude-sonnet-5" } } }
}
```

`defaults` is `createKarmi({ defaults })` and `catalogue` is `karmi.catalogue.describe()`,
both as JSON; only the names each kind defines are read. A check whose input is
absent reports `--` and never fails the run.

Every check is also a function. `decodeWranglerConfig`, `decodeDoctorManifest`,
`runChecks`, `formatFindings` and `hasFailure` are exported, so the three
manifest-driven checks can run in a test instead, where the real Catalogue and
Agent Specs are already in memory and nothing has to be written down twice:

```ts
const findings = await runChecks({
  config: decodeWranglerConfig(wranglerJsonc),
  manifest: decodeDoctorManifest({ catalogue: karmi.catalogue.describe(), specs: { concierge: spec } }),
});
expect(findings.filter((finding) => finding.status === "fail")).toEqual([]);
```

The scaffolded template does exactly this, so every check runs on every commit.

## Testing

`@karmi/core/testing` ships `fakeProvider`, a scripted Provider that is registered like any other:

```ts
import { fakeProvider, reply } from "@karmi/core/testing";

const provider = fakeProvider(({ request, index }) =>
  index === 0 ? [reply.reasoning("…"), reply.toolCall("weather", { city: "Oslo" })] : "Sunny in Oslo",
);
createKarmi({
  catalogue,
  providers: { fake: provider },
  defaults: { providers: { default: { adapter: "fake", models: ["*"] } } },
});
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
export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;

// In a test, after evictDurableObject(stub):
await clock.advance("24h"); // Also fires due alarms through cloudflare:test.
```

`advance()` accepts milliseconds or durations with `ms`, `s`, `m`, `h`, or `d` suffixes. It moves the clock forward and dispatches due alarms; live or recovered Steps continue in-process, so observe completion through the Thread's event stream.

## Schedules

A Thread can wake itself. `thread.schedule({ delay: "24h", input })`, `{ at }` (epoch milliseconds or ISO 8601) or `{ cron: "0 9 * * 1-5", tz: "Europe/Berlin" }` (five fields, IANA zone, UTC by default) returns `{ scheduleId, nextAt }`; `thread.cancelSchedule(scheduleId)` and `thread.schedules()` complete the API, and `thread.status().nextScheduleAt` reports the soonest. Exactly one of `at`, `delay` or `cron` is given, and `input` is an Event, the same shape `send()` takes. Scheduling on a Thread addressed by identity creates it.

```ts
const thread = karmi.scope("tenant").thread({ agent: "billing", user: "payer", threadId: "dunning" });
const { scheduleId, nextAt } = await thread.schedule({
  delay: "3d",
  input: { kind: "event", type: "invoice.overdue", payload: { invoice: "inv_42" } },
});
```

A firing is an ordinary `send()` of the Event on the Thread's own Durable Object alarm, so it coalesces into the next Turn while one runs or is parked. A cron holds at most one undelivered firing: a tick that arrives while the last one is still queued is logged as `schedule.skipped` and the cron rearms. A one-shot is deleted on delivery, and an `at` already in the past fires at once; a Turn that fails is not retried. A cron's next tick is computed from the time it actually fired, so ticks missed while the Durable Object was unreachable are not replayed. `schedule.created`, `schedule.fired`, `schedule.skipped` and `schedule.cancelled` record everything. Every Thread holds at most 100 pending Schedules, none further than a year ahead.

The `scheduling` Capability gives an Agent `schedule`, `cancel_schedule` and `list_schedules` for its own Thread and no other; a firing reaches it as `{ kind: "event", type: "schedule.fired", payload }`. Its `{ maxPending, maxHorizonMs, cron }` are bounded by the Scope ceiling and the caps above, and a Permission Policy rule naming `schedule` may `ask`.

External triggers stay your code. A Worker `scheduled()` or `queue()` handler maps the trigger to a Thread and sends the same Event shape; karmi keeps no taxonomy of where Events come from and does not dedupe repeated deliveries.

```ts
export default {
  async scheduled(controller: ScheduledController, env: Env) {
    await karmi
      .scope("tenant")
      .thread({ agent: "reporter", threadId: "daily-report" })
      .send({ kind: "event", type: "report.daily", payload: { cron: controller.cron, at: controller.scheduledTime } });
  },
  async queue(batch: MessageBatch<{ scope: string; user: string; order: string }>) {
    for (const message of batch.messages) {
      const { scope, user, order } = message.body;
      await karmi
        .scope(scope)
        .thread({ agent: "orders", user, threadId: `order-${order}` })
        .send({ kind: "event", type: "order.placed", payload: message.body });
      message.ack();
    }
  },
};
```

## Compaction and forking

Long Threads keep working. Before every fresh model Step, and after a `context_window_exceeded` stop, the Harness compares the context (the last model Step's usage plus a cheap estimate of what was logged since, never a re-tokenisation) with `context.window - reserveTokens`. Over it, a `compact` Step runs: the cut walks back to `keepRecentTokens`, then to the start of that Turn (falling back to a tool Step boundary, never inside a call/result batch), the events before the cut are summarised, and `thread.compacted { trigger, firstKeptSeq, tokensBefore, tokensAfter, strategy, summary, attachments }` is appended. The log is never rewritten: the next request is the Prompt, the summary, and the events from `firstKeptSeq` on. Summaries chain, and the media of the summarised events is carried forward as `attachments`.

`context.window` defaults to what the adapter reports for the model (`capabilities(model).contextWindow`) and is capped by the Scope ceiling `ceilings.context.window`; `reserveTokens` (16k) and `keepRecentTokens` (20k) have Framework defaults. The summary is written by the Harness's own model call by default, or by the provider when the Provider profile says `compaction: "provider"` (Anthropic's `context_management` compaction; the returned block replays byte-exact to the same provider and as text elsewhere, and a reply without a block, as under the provider's 50k-token minimum, is taken as a Harness summary instead). A `compact` Step counts against `longRunning.maxSteps`, is watchdog-covered and re-runs whole after an eviction.

`before-compact { trigger, instructions?, tokensBefore }` Hooks may answer `{ skip: true }` or `{ summary }`; a Hook summary is ignored under the `provider` strategy, which cannot take one. `after-compact { compacted }` observes. `thread.compact({ instructions })` compacts an idle Thread on request. `thread.fork(seq, { threadId? })` opens a new Thread for the same Agent and User holding the log up to `seq`, after a Compaction included; the fork reads the original's media by reference and joins the Scope's Thread index on its first Turn.

## Skills and deferred Tools

Context is disclosed progressively. A Skill (`defineSkill({ name, description, body, tools?, invokableBy? })`) always shows its description in the Prompt's Skill index; its body Fragment and Tools enter context only when it is activated, by the model through the built-in `use_skill` or by a User command (`send({ kind: "message", parts, skill: "name" })`), as `invokableBy` allows (`both` by default; a Spec reference may narrow it). Activation appends `tools.loaded { names, skill }`; a Tool of an inactive Skill is neither offered nor callable.

Large Tool sets defer. `context.tools.defer` is `auto` (the default: when the deferrable definitions would take `threshold`, 10 % by default, of the context window, all of them defer), `always` or `never`. Built-ins, Skill Tools and references pinned with `{ name, alwaysLoad: true }` never defer and do not count. The model sees a names-only index after its Tool instructions and loads definitions through the always-present, read-only `tool_search { query }`: `select:a,b` for exact names, or keywords matched in memory over names, descriptions and argument names, at most five per search. Each load appends `tools.loaded { names }`, and the result carries `tool_reference` blocks. The loaded set is the union of load points since the last Compaction's `firstKeptSeq`: it survives Turns and parking, and a Compaction that cuts a load point unloads its Tools. Calling an unloaded Tool answers an `isError` result without running anything. The Policy is resolved on the whole set first: a denied Tool is never indexed, an `ask` still pauses at call time, and a Policy that names `tool_search` to deny it while deferral is on fails validation (`policy.tool-search-denied`).

`@karmi/anthropic` encodes this natively (`defer_loading: true`, references replayed as `tool_reference` blocks in the `tool_result`, no `cache_control` on deferred definitions); `@karmi/ai-sdk` resends the definitions the transcript has loaded, with each reference rendered as text.

## Memory

Agents remember Users. An Agent Spec with a `memory` block shares one Memory per (Scope, User) with every other Agent in the Scope. It holds a Profile, whose fields are the union of every Agent's `memory.profile` properties, and free-form Notes. A field with a different type in two Agents is a `put` error (`memory.profile.conflict`). Memory lives in its own Durable Object, so bind `KARMI_MEMORY` to `MemoryDO` as the wrangler baseline shows.

```ts
defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "Help the guest." }],
  model: { id: "anthropic/claude-sonnet-5" },
  memory: { profile: { properties: { tier: { type: "string", enum: ["silver", "gold"] } } } },
});
```

The model sees a Memory Fragment after the Skill index. It shows the Profile and the 20 most recent Notes, and is read once at the start of each Turn. Two built-ins write and search it:

- **`remember { profile?, note? }`** merges Profile fields and appends a Note. An Agent may write only the fields its own schema declares, each checked against that schema, and every other field is kept. Setting a field to `null` clears it.
- **`recall { query }`** searches Notes with full-text search and returns the 10 best matches. It sees a `remember` from earlier in the same Turn.

`memory.notes: false` drops Notes: `recall` is not offered and `remember` takes only `profile`. Both built-ins are allowed by default, and a Policy rule that names one of them applies. On a user-less Thread the Fragment renders nothing and both Tools answer `isError`. A Delegation child acts for its parent's User, so it reads and writes the same Memory.

`scope.users.memory.get(user)` reads a Memory, and `list()` names every User with stored Memory. `delete(user)` removes the User from that list and deletes their Memory.

## Offline delivery

Register a Channel's delivery callback in the Catalogue and set its route on an inbound input:

```ts
const receipt = defineDeliverer({
  name: "receipt",
  granularity: "turn", // "part" by default; "delta" includes streaming chunks
  async deliver(threadKey, events, ref) {
    await sendReceipt(ref, events, threadKey); // your Channel integration
  },
});
const karmi = createKarmi({ catalogue: { agents: [agent], deliverers: [receipt] } });
export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export default { queue: karmi.queueHandler };

await karmi
  .scope("tenant")
  .thread({ agent: "billing", user: "payer", threadId: "receipt" })
  .send({
    kind: "event",
    type: "payment.received",
    payload: { amount: 100 },
    channelRef: { deliverer: { name: "receipt", ref: { chat: "payer" } } },
  });
```

The Thread remembers the last supplied `channelRef.deliverer`; inputs without one retain the route. Each completion or Approval request captures that route and an event range. A durable alarm gives subscribers one second to consume the trigger before enqueueing it. The Queue checks consumption again before calling the Deliverer. Merely polling `events()` or opening a subscription does not count as consumption: the iterator must reach the completion or Approval event. A subscriber racing an in-flight delivery can still see the same event.

Delivery uses the persisted event log at the Deliverer's granularity, including Approval events. Successive ranges in a Turn do not overlap. Without a Deliverer, output stays available through `events()` and `subscribe()`.

Delivery is at-least-once, independent of Turn success; deduplicate side effects using the Thread key and event `seq` within your Channel's Scope. Queued delivery and late delivery alarms skip destroyed Scopes. Configure `KARMI_QUEUE` and export `karmi.queueHandler`; the published Wrangler baseline retries three times and routes exhausted messages to `my-karmi-dlq`. Create both queues when provisioning the deployment and operate the DLQ using [Cloudflare's dead-letter queue guidance](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

## Usage records and logging

Every model Step, compact Step and Script run appends a `usage.recorded` event in the same write as the Step it accounts for. A model or compaction record carries the call's tokens (input, output, cache read and write, one-hour cache write, reasoning), `model`, `provider`, `profile`, the credential's `credentialSource` and `credentialVersion`, any `fallback`, `serverToolCalls`, and the attribution `{ scope, agent, user?, threadId, parent?, turn, seq }`. A Script record carries its `tier`, `wallMs` and `callId`. Delegation children record their own spend with `parent` set; nothing is counted twice. `thread.status().usage` sums the tokens of the Thread.

`cost { amount, currency: "USD", source, basis, upstream?, byok? }` is present only when OpenRouter or the Vercel AI Gateway reported one on the final stream part. karmi has no price table. Cloudflare AI Gateway reports no cost in the response, so such a record carries `gateway { provider: "cloudflare", id }` with the `cf-aig-log-id` for the Platform to join against the gateway log.

List a `UsageHandler` in the Catalogue to receive records in batches through `KARMI_QUEUE`:

```ts
const meter = defineUsageHandler({
  async onUsage(records) {
    for (const record of records) await bill(usageKey(record), record); // idempotent by threadId:seq
  },
});
const karmi = createKarmi({ catalogue: { agents: [agent], usageHandler: meter } });
export default { queue: karmi.queueHandler };
```

Delivery is at-least-once with `usageKey(record)` (`threadId:seq`) as the idempotency key. A thrown error retries the batch and never fails the Turn. Without a handler the records stay in each Thread's log. A handler without `KARMI_QUEUE` is a boot error.

Tools, Hooks and Retrievers log through `ctx.logger`. Every line carries the Scope, Agent, User, Thread and Turn it concerns. The default writes one JSON line per call on the Worker console; pass `createKarmi({ logger })` to send lines elsewhere. Before a line reaches any Logger, a `SensitiveValue`, a field named like a credential (`token`, `secret`, `password`, `authorization`, `apiKey`, `cookie`) and a bearer token inside text are replaced by a marker. Tracing is the event log; karmi ships no OpenTelemetry.

Media travels as refs. Bind `KARMI_MEDIA` to R2, then upload through the owning Thread:

```ts
const media = await thread.uploads.put(request.body, {
  mimeType: "application/pdf",
  name: "report.pdf",
});
await thread.send({ kind: "message", parts: [{ type: "file", media }] });
```

A ref has `{ id, key, mimeType, bytes, name? }`. karmi sniffs the MIME (using the caller's claim when it cannot identify the bytes), measures the stream, and mints a ULID under `{scope}/media/{threadId}/`. `defaults.media` and `scope.config.set({ media })` accept `maxBytes` (100 MiB by default) and optional `allowedTypes` (MIME names or wildcards such as `image/*`). Scope limits can only tighten the Deployment limits. Overflow aborts the multipart upload. Tools use `ctx.media.put(body, { mimeType, name })` under the same limits; native Tool/MCP image blocks and generated model images become refs before persistence.

Adapters read refs through `ProviderCallOptions.media` and inline base64 when building a request. Images and PDFs are supported; audio and video follow model capabilities, with unknowns sent optimistically. A non-PDF `file` Part is always described as text. Unsupported or oversized media and unavailable objects become placeholders. The test kit uses the Worker's local R2 binding.

For read URLs, configure `createKarmi({ media: { accountId, bucket, accessKeyId, secretAccessKey } })` with R2 S3 credentials from Worker secrets. `await karmi.media.url(ref, { ttl: 300 })` returns a presigned GET; `ttl` is seconds, from 1 through 604800. Signing credentials stay outside Scope config and Thread state.

`await thread.delete()` immediately tombstones the Thread and stops new work. Its scheduler removes media and Tool-output spill in batches, then clears conversation rows and the Scope's Thread index. Only the deletion marker remains, preventing reuse of that Thread identity. Media has no TTL. Forks share refs with their source Thread, so deleting the source makes those attachments unavailable in its forks.

### Provider tools

Grant provider execution separately from Harness Tools:

```ts
capabilities: {
  providerTools: {
    tools: ["web_search", "web_fetch"],
    limits: { maxCallsPerTurn: 4, maxCallsPerThread: 20 },
  },
}
```

Anthropic supports both names. The AI SDK adapter supports `web_search` through
OpenAI Responses (`openai/*` models); other resolved providers fail validation.
`code_execution` is reserved. Scope ceilings also apply when a Spec omits limits.
Policy rules include or exclude Provider Tools at request build; explicit `ask`
is invalid, and a grant with no matching rule allows the tool. Provider Tools
are absent from scripts, and a delegated Agent uses its own grants.

Profile pins live at `providerOptions.anthropic.serverTools`, for example
`[{ name: "web_search", type: "web_search_20260318" }]`, or at
`providerOptions.openai.serverTools`, for example
`[{ name: "web_search", type: "web_search_preview" }]`. Pins never grant access.
Anthropic defaults to the `20260318` search and fetch versions. OpenAI defaults
to `web_search`. Anthropic divides the remaining budget among enabled tools using
`max_uses`; OpenAI sends it as `max_tool_calls`. Tools disappear at the ceiling.

Each call produces `server_tool.called` and `server_tool.result` events within
the model Step and contributes to `Usage.serverToolCalls`. Large native results
spill to R2 under the same limits as Tool output. Same-provider replay restores
the native result; a provider switch sends its summary as assistant text.
OpenAI's AI SDK transport replays the original result by its stored item ID and
requires `store: true` (the SDK default). A grant with `store: false` fails
validation, and a later attempt to replay history with storage disabled fails
before sending a request. An `aiSdk` model factory serving `openai/*` must return
an OpenAI Responses model; the adapter rejects a mismatched factory at request
build because the factory is arbitrary application code.
`before-tool` does not run; `after-tool` observes the result and cannot change it.
The Prompt names the Provider Tools enabled for the current Step.

### Knowledge

Bind `KARMI_KNOWLEDGE` to `KnowledgeDO` and add the `karmi-v3` SQLite migration from the
published Wrangler baseline. A corpus belongs to one Scope and is shared by its Agents:

```ts
const faq = scope.knowledge("faq");
await faq.ingest([{ id: "refunds", text: "Refunds are available within 30 days." }]);
await scope.agents.put({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer from the company FAQ." }],
  model: { id: "anthropic/claude-sonnet-4-5" },
  knowledge: [{ name: "faq", mode: "search" }],
});
```

Search mode adds the read-only `search_faq` Tool. It is always loaded and respects explicit
Permission Policy rules. `mode: "tool"` remains an alias for search. `mode: "inline"` puts the
whole corpus in the prompt and fails the Turn if its text exceeds 32,000 Unicode code points,
including separators. Inline text preserves documents without overlapping chunk duplicates.
Knowledge names use 1–57 letters, digits, underscores or hyphens.

`faq.search(query)` returns at most ten FTS5 BM25 passages by default, each with `docId`, `seq`,
`text`, `score` (higher is better), and metadata. `faq.delete(ids)` removes documents, `faq.destroy()`
clears the corpus and its Retriever mirror, and `scope.knowledge.list()` lists ingested corpora.
Reingesting a document replaces all of its old chunks. The first ingest fixes `index` options
(`chunkSize: 2000`, `overlap: 200`, in Unicode code points) and the indexing Retriever and settings.
Destroy the corpus before changing these options.

Ingests above 64,000 UTF-16 code units or 32 documents return `{ pending: jobId }`. The DO alarm
processes batches and checkpoints each document. Read progress with `faq.jobs.get(jobId)`.
Supply a stable `jobId` to make retries of a submitted request return the same Job; reusing that
id for different input fails. Other writes reject with `knowledge.busy` until the pending ingest finishes.
Destroy also waits for any pending Thread completion callback. Searches can
see the documents already committed. Pass `threadKey: thread.key` when a Tool returns the
pending result so the Job reports completion through `thread.jobs`. Small ingests return
`{ indexed: count }` directly.

A Catalogue `defineRetriever` can supply `index`, `search`, `delete`, and `destroy`. Ingest passes
Framework-produced chunks, identified by `(id, seq)`. Every operation receives `RetrieverCtx`
with its Scope and corpus name, parsed settings, logger, abort signal, and access to the local
FTS5 search and bounded inline corpus. Index, delete and destroy callbacks must be idempotent:
recovery can repeat an external operation before its local checkpoint is committed. Select the
indexing Retriever through ingest options; a Spec may select a search Retriever by name and
provide validated settings. The default `fts5Retriever` needs no external service.

## Vector and hybrid Knowledge retrieval

Register a vector Retriever in the Catalogue. SQLite is the default vector store;
Workers AI supplies `@cf/baai/bge-m3` embeddings through `KARMI_AI` unless you pass
an `Embedder` implementation backed by your own provider.

```ts
import { createKarmi, vectorRetriever, hybridRetriever } from "@karmi/core";

const karmi = createKarmi({ catalogue: { retrievers: [vectorRetriever, hybridRetriever] } });
const knowledge = karmi.scope("acme").knowledge("handbook");
await knowledge.ingest([{ id: "refunds", text: "Refunds are available within thirty days." }], {
  retriever: "vector",
});
const hits = await knowledge.search("return a purchase", {
  settings: { mode: "hybrid", topK: 10 },
});
```

The first ingest fixes the embedding model, dimensions, metric, chunking and
indexing Retriever. A changed embedding configuration is rejected; create a new
Knowledge corpus to use a different model. Search can override `mode` and `topK`.
Hybrid mode combines BM25 and vector ranks by reciprocal-rank fusion with a
constant of 60. `defineVectorRetriever({ name, rankConstant })` changes that
constant. Memory recall continues to use FTS5.

`defineVectorRetriever({ name, embedder, maxChunks })` accepts custom embeddings
and a SQLite page size. The default `maxChunks: 1000` comes from the
[workerd measurements](../../docs/research/vector-workerd-timings.md). Larger
corpora are scanned in pages, with at most 100 ranked results retained.

For Vectorize, bind one index per Deployment and embedding model. Use the same
binding for every Scope; the adapter supplies the Scope namespace and hashes
remote IDs so identical IDs in different Scopes cannot overwrite each other.

```ts
import { env } from "cloudflare:workers";
import { defineVectorRetriever, VectorizeStore } from "@karmi/core";

const search = defineVectorRetriever({
  name: "search",
  store: (ctx) => new VectorizeStore(env.KNOWLEDGE_VECTORS_BGE_M3, ctx.storage, ctx.embedding?.metric),
});
```

The adapter metric defaults to cosine; pass the Knowledge metric when using a
custom embedding model. Scores use the same larger-is-better convention as SQLite.

Create the index and both string metadata indexes **before ingesting vectors**:

```sh
pnpm exec wrangler vectorize create karmi-bge-m3 --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index karmi-bge-m3 --property-name=knowledge --type=string
pnpm exec wrangler vectorize create-metadata-index karmi-bge-m3 --property-name=doc --type=string
```

Bind that index in `wrangler.jsonc`, then check the actual bound index:

```sh
# Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.
pnpm exec karmi doctor --config wrangler.jsonc --binding KNOWLEDGE_VECTORS_BGE_M3 --dims 1024 --metric cosine
```

`--binding` names any Vectorize binding, so a custom Retriever's index is checked
the same way as the built-in `KARMI_VECTORIZE`. The check reads dimensions, metric
and metadata indexes through the management API and never provisions or alters
the index. See [`karmi doctor`](#karmi-doctor) for the rest of the checks.

Embeddings and the id ledger are stored in the Knowledge Durable Object before
external writes. `knowledge.rebuild()` restores the mirror from those saved
vectors without embedding again. Document replacement and deletion use the
ledger's IDs; `destroy()` deletes those IDs in batches, clears any remaining
adapter entries for that Knowledge, then clears the corpus. Other corpora in
the Scope remain intact. Vectorize mutations are asynchronous, so search may
lag an acknowledged write; see the [Vectorize API documentation](https://developers.cloudflare.com/vectorize/reference/client-api/).

The normal test configuration disables remote bindings. The separate live suite
uses only a disposable `karmi-test-vectors` index with two dimensions, cosine
metric, and the same two metadata indexes. After provisioning it and authenticating
Wrangler, run:

```sh
KARMI_VECTORIZE_LIVE=1 pnpm --filter @karmi/core test:vectorize-live
```

The live configuration refuses to run in CI. It is never included in the ordinary
test suite. The local tests use deterministic embeddings and SQLite only.
