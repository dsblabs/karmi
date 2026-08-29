# Cloudflare account and local dev

Record for [Provision the Cloudflare features the spec assumes](https://github.com/dsblabs/karmi/issues/12).
What the runtime decision ([Challenge the runtime](https://github.com/dsblabs/karmi/issues/2),
[`docs/research/runtime-comparison.md`](../research/runtime-comparison.md) §2) assumes, what has been verified,
and where credentials live. **No secrets in this file, ever.**

## Local dev toolchain — verified 2026-08-29

Verified on macOS arm64, Node 24.19, Docker 29.7.2, with a throwaway project (`/tmp/karmi-cf-probe`, not kept).
Versions: `wrangler` 4.127.1, `@cloudflare/vitest-pool-workers` 0.22.0, `vitest` 4.1.11, `workerd` 1.20260828.1,
`compatibility_date` 2026-08-20 with `nodejs_compat`.

| Feature | Local check | Result |
| --- | --- | --- |
| Durable Object, SQLite backend (`new_sqlite_classes`) | `ctx.storage.sql.exec` create/insert/count; `setAlarm` + `runDurableObjectAlarm` | pass |
| Workflows | `WorkflowEntrypoint` with `step.do` + `step.sleep("1 second")`, polled `instance.status()` to `complete` | pass |
| Queues | producer binding `send()` → `queue()` consumer handler writing into the DO | pass (`miniflare.queueConsumers` needed in test config) |
| R2 | `put`/`get` under a `{scope}/…` key prefix | pass |
| Dynamic Workers (`worker_loaders` binding) | accepted by `wrangler dev` as a local "Worker Loader" binding | starts |
| Containers / Sandbox SDK | not exercised; Docker daemon present for when a container test is written | n/a |

Notes for the eventual karmi test setup:

- pool-workers 0.22 (Vitest 4) dropped `defineWorkersConfig` from `…/config`; use the Vite plugin form:
  `import { cloudflareTest } from "@cloudflare/vitest-pool-workers"` → `plugins: [cloudflareTest({ wrangler: { configPath }, miniflare: {…} })]`.
  Types come from `@cloudflare/vitest-pool-workers/types`.
- npm ≥ 11 blocks `workerd`'s postinstall until `npm approve-scripts --allow-scripts-pending` (pnpm has the same gate via `onlyBuiltDependencies`); the monorepo config must allow-list `workerd`.
- Whole suite (4 tests, one worker with DO + Workflow + Queue + R2) runs in ~1.5 s.

## Account — pending

Nothing on this workstation is authenticated (`wrangler whoami` → not authenticated; no `~/.wrangler`, no `CLOUDFLARE_*`).
Fill in once provisioned:

| Item | Value |
| --- | --- |
| Account id | _pending_ |
| Plan | _pending_ (Workers Paid required) |
| AI Gateway id | _pending_ |
| R2 bucket (media / spill) | _pending_ |
| Containers enabled / default instance type | _pending_ (`lite`) |
| Workers for Platforms | _pending_ — decision: enable now or defer |
| Dynamic Workers beta access | _pending_ |
| Where API tokens / Anthropic key live | _pending_ (never in this repo) |
