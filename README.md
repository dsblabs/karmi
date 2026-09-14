# karmi

A code-first TypeScript framework for building agent harnesses that run natively on Cloudflare. See [`packages/core`](./packages/core), the Anthropic Provider in [`packages/anthropic`](./packages/anthropic), and the glossary in [`CONTEXT.md`](./CONTEXT.md).

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## Isolate scripts

Add `"worker_loaders": [{ "binding": "KARMI_LOADER" }]` to your Wrangler config,
then grant an Agent `capabilities.scripts`:

```ts
capabilities: {
  scripts: {
    tier: "isolate",
    tools: "allowed", // or a subset of the Agent's Tool names
    limits: { cpuMs: 1000, wallMs: 60000, maxToolCalls: 100 },
  },
}
```

The model receives `run_script({ code, description? })` and a usage Fragment with
TypeScript input declarations. Code is a JavaScript module, for example:

```js
export default async () => {
  const results = await Promise.all([
    tools.weather({ city: "Paris" }),
    tools.weather({ city: "London" }),
  ]);
  console.log("Looked up two cities");
  return results;
};
```

Each call runs in a new Dynamic Worker with outbound access disabled and no
filesystem, secrets or storage bindings. Only allow-resolved Tools are exposed;
`ask`, denied, provider-executed and framework built-in Tools are excluded.
Deferral and Skill activation do not restrict script reachability. Tools requiring
a User are omitted from user-less Threads and named in the usage Fragment.
Bridge calls run serially, pass through input validation and before/after-tool
Hooks, and cannot park for approval, consent or a Job.

A Tool returns its `structuredContent` when present, otherwise its text. Tool
failures throw inside the script. `__result(callId)` reads a prior Tool result on
the same Thread; stable call IDs are `{threadId}:{tool.call seq}`. Child calls and
results carry `parentCallId` and stay out of model context, including compaction.
The script result contains `value` or `error: { message, stack? }`, captured `logs`,
a compact `toolCalls` summary and `artifacts: []`. Console capture is bounded to
30,000 characters. A `usage.recorded { kind: "script", tier, wallMs, callId }`
event reserves the accounting hook point.

Omitted limits use the values above, lowered by Scope ceilings. An explicit
over-ask fails validation; a missing Loader produces `capability.unavailable`.
Limit errors name `cpuMs`, `wallMs` or `maxToolCalls`. Cancellation and completion
revoke the bridge and dispose the Worker handles. A Tool that has already made
an external change cannot be rolled back by cancellation.

`Sandbox` is the exported execution seam; `CloudflareIsolateSandbox` implements
it. The integration tests use the real Worker Loader in Miniflare. Local workerd
does not enforce CPU quotas, so the CPU-exhaustion test is explicitly skipped;
`cpuMs` is passed to Cloudflare's native [resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
The narrow Codemode adaptation and its MIT license are under
`packages/core/src/vendor/codemode/`.
