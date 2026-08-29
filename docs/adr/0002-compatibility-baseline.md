# 2. Compatibility baseline: a date floor, no Node built-ins in core, no decorators

Date: 2026-08-30. Status: accepted. Decided in [Compatibility baseline: nodejs_compat, decorators, and what user code may assume](https://github.com/dsblabs/karmi/issues/19).

## Context

The Cloudflare Agents SDK requires `nodejs_compat` (`node:async_hooks` for implicit context, `node:diagnostics_channel` for observability) and a TC39 decorator transform (`@callable`), coupling every consumer to a bundler configuration. karmi builds *beside* that SDK ([docs/research/agents-sdk.md](../research/agents-sdk.md)) and must state its own baseline: what a Worker hosting karmi code — the Framework's own Workers and Scope-isolated user Workers under Workers for Platforms — must enable, and what user code may assume of the toolchain. Since 2026-08-04 Cloudflare enables `nodejs_compat` by default for any `compatibility_date` on or after that day, so the flag can be a consequence of a date rather than a requirement in its own right.

## Decision

- **One hard requirement: `compatibility_date ≥ 2026-08-04`** for every Worker that runs karmi code, including WfP user Workers (the Platform sets date and flags at upload; karmi publishes the required set). `nodejs_compat` is implied and never named. An older date is a hard error at startup, not a degraded mode.
- **`@karmi/core` imports no `node:*` builtins.** Turn context (Scope, Thread, Step) is passed explicitly as an argument to Tools, Hooks and Prompt functions — no `AsyncLocalStorage`. Observability goes through the Thread event log and the `Logger` seam — no `diagnostics_channel`. Adapter and peripheral packages may use Node builtins when a dependency needs them.
- **No decorators anywhere**, public API or internals, and no `reflect-metadata`. Catalogue registration is plain functions and config objects (`defineTool({...})`-style); the DO base class exposes overridable methods.
- **Other flags are recommended, not required.** karmi ships one documented wrangler baseline (date floor plus `global_fetch_strictly_public` for SSRF hardening); a dev-time `doctor`-style check warns on deviations. A missing Worker Loader binding is reported through Agent Spec validation as "scripts Capability unavailable" (see [Script execution as a gated capability](https://github.com/dsblabs/karmi/issues/9)).
- **Toolchain baseline user code may assume:** ESM-only packages (no CJS build); TypeScript ≥ 5.9 with `moduleResolution: "bundler"`; Node ≥ 22 for tooling only — workerd is the only runtime target; `zod` v4 is the single schema library across the public API (Tool input, Agent Spec, ProviderConfig) with JSON Schema emitted for the wire; tests run in `@cloudflare/vitest-pool-workers`.

## Consequences

- karmi and user code build with wrangler's default esbuild, tsdown or Vite with zero transform configuration; the framework's baseline is a single date line in `wrangler.jsonc`.
- Explicit context costs a parameter on every Tool/Hook/Prompt signature, and buys testability, hibernation safety (no ambient state to lose across a DO alarm boundary) and code that reads plainly to outsiders.
- Raising the floor later (a newer date for a newer default flag) is a documented breaking change per major, not a silent drift.
- Pinning zod v4 rules out Standard Schema–agnostic input in v0; revisit if a second schema library becomes a real demand.
- The `doctor` check and the published wrangler baseline are concrete deliverables for the package-layout decision ([Monorepo package layout and public API surface](https://github.com/dsblabs/karmi/issues/11)).
