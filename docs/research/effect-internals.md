# Effect for `@karmi/core` internals: adopt, borrow patterns, or stay on plain Promises

Research note, 2026-09-03, answering GitHub issue #39. Primary sources only: the npm registry (`npm view`), the `effect` package contents installed into `/tmp` (3.22.1 and 4.0.0-rc.112), the Effect-TS/effect repository via the GitHub API, effect.website docs and blog, developers.cloudflare.com, the published `package.json` of every harness named in the ticket, and measurements made locally with esbuild 0.28.2 and workerd 2026-09-03 (`npx workerd serve` against a capnp config with `compatibilityDate = "2026-08-04"`). Every claim carries a bracket key from section 8. Glossary (Step, Turn, Thread, Tool, Workspace, Provider) follows `CONTEXT.md`; prior decisions are cited as [ADR-2] (compatibility baseline) and [PS] (provider seam).

Date-sensitive: `effect` `latest` is 3.22.1 (2026-07-30); 4.0.0-rc.112 (2026-08-25) is the `rc` dist-tag and the blog says "We think we are ready to ship" (2026-08-12) with "No broad breaking changes planned for the RC cycle" (2026-08-31) [E-npm][E-blog-rc][E-blog-aug]. A 4.0 stable is plausibly weeks away; the numbers below are given for both majors.

## 1. Summary and recommendation

**Recommendation: borrow patterns only. Do not take `effect` as a dependency of `@karmi/core` in v0.** The prior in the ticket holds; the evidence does not contradict it, and two findings strengthen it.

1. **It costs 115–170 KB gzipped on the hot path and ~45 ms of extra isolate start for the fibre runtime alone.** A minimal program importing `Effect, Layer, Stream, Schema, Scope, Schedule` bundles to 551 KB minified / 169 KB gzipped on 3.22.1 and 369 KB / 115 KB on 4.0.0-rc.112 (esbuild, `--platform=browser --bundle --minify`, tree-shaken) [M-bundle]. That is well under the 3 MB free / 10 MB paid compressed script limit [CF-limits], so size is not a blocker, but it is 1.2–1.8× the whole AI SDK core [PS §2.1] and 25–40× the 4.5 KB of `zod/mini`, for a runtime whose main asset (in-memory fibres) is exactly the thing the Step model does not rely on. Spawn-to-first-response in workerd rose from ~120 ms (hello world) to ~135 ms (`Effect` only) and ~170 ms (the five-module program), against ~130 ms for `zod` [M-cold]. A Thread DO wakes on every Turn after hibernation (10 s idle) and re-evaluates the script after eviction (70–140 s idle) or any deploy [CF-lifecycle]; a fixed ~50 ms tax on each of those is real money on a per-Thread DO, and no other candidate in the stack pays it.
2. **Effect's runtime model is orthogonal to the Step model, not a substitute for it.** Fibres, `Scope` finalizers and interruption are in-memory constructs; a DO that hibernates or is evicted discards them without running finalizers ("the in-memory state is discarded"; `setTimeout` callbacks "cannot be recreated") [CF-lifecycle][CF-inmem]. karmi already decided that the persisted event log is the only state at a Step boundary and that an unfinished Step re-runs from the log with the read-only/idempotent rule for half-finished tool batches [CONTEXT Step]. Everything Effect would add sits *inside* one Step: cancel a tool batch, time out a model call, retry a 529, release an MCP session or Workspace. Those are single-invocation concerns that `AbortSignal.any`/`AbortSignal.timeout`, `await using` and a 40-line retry helper cover at 0.5 KB, all verified running natively in workerd today [M-plain][M-using].
3. **No precedent, and one live workerd bug.** None of Claude Code, Codex CLI, pi, `@cloudflare/think`, `agents`, `@cloudflare/ai-chat` or `@cloudflare/sandbox` depends on `effect` [P-cc][P-codex][P-pi][P-think][P-agents][P-aichat][P-sandbox]. The only Cloudflare-adjacent Effect production user found is Alchemy 2 (IaC, runs in Node/Bun, not workerd) [P-alchemy]. Effect-TS does ship `@effect/sql-sqlite-do` (a DO SQLite client, 0.30.0 on v3, `rc` on v4) and `@effect/sql-d1`, so Workers is a supported target in intent [E-sqlite-do][E-readme], but the fix for "Cloudflare Workers disallow timers in global scope, so an effect that yielded while running at module load failed with `Disallowed operation called within global scope`" was merged **today** (2026-09-03, #7930) and is not in any released version [E-sched-fix]. It is a foot-gun with an easy workaround (never run effects at module scope), but it shows the Workers path is not well trodden.
4. **Schema would be a second schema library or a migration off zod, both of which [ADR-2] rules out for v0.** `effect/Schema` has been in core since 3.10 (`@effect/schema` is deprecated: "merged into the main effect package") and the v4 RC keeps it in core with a `StandardSchema` bridge [E-schema-dep][M-v4-modules]. Adopting it for Tool input would either replace zod v4 on the public API (breaking the ADR and the AI SDK/MCP ecosystem shape, which is zod-first [PS]) or run both, which doubles the size again (Schema alone is 97 KB gz on v3 / 71 KB on v4 [M-bundle]).
5. **The façade problem is real but not decisive.** A plain public API over Effect internals is workable (`Effect.runPromise(e, { signal })` exists and AbortSignal cancels the fibre [E-runPromise]), but every seam that user code implements — Tool handlers, Hooks, Provider adapters, Retriever, Deliverer, UsageHandler — would need an Effect-side wrapper (`Effect.tryPromise` + a tagged error) and a Promise-side unwrapper, and the streaming seam (`Provider.stream()` as `AsyncIterable<ProviderEvent>` [PS §4]) would be `Stream.fromAsyncIterable` in and `Stream.toAsyncIterable` out. That is roughly one adapter per seam, not "double every type", but it is exactly the machinery [AGENTS.md] says not to introduce for architectural taste.

What would change this: (a) a karmi component that genuinely needs structured concurrency across many long-lived in-memory fibres inside one invocation — e.g. a Delegation fan-out of dozens of child Threads supervised in one DO, or an Effect-based `@effect/ai`-style provider layer that becomes the ecosystem default; (b) Effect 4.0 stable shipping with a documented Workers target (tests under `@cloudflare/vitest-pool-workers`, a `Scheduler` that is safe at module scope) and the core dropping to the ~30 KB gz its `Effect`-only slice already is [M-bundle]; (c) a peripheral package (not core) — say `@karmi/workflows` on Cloudflare Workflows — where a Layer/Scope model would pay for itself and the bundle lives in a separate Worker.

## 2. Facts measured and verified

### 2.1 Package facts

| Item | 3.22.1 (`latest`) | 4.0.0-rc.112 (`rc`) | Source |
|---|---|---|---|
| Published | 2026-07-30 | 2026-08-25 | [E-npm] |
| Licence | MIT | MIT | [E-npm] |
| `dependencies` | `fast-check ^3.23.1`, `@standard-schema/spec ^1.0.0` | `msgpackr ^2.0.5`, `fast-check ^4.9.0` (blog says core is now dependency-free; the published RC still lists two) | [E-npm][E-blog-aug] |
| Unpacked size | 27.2 MB | 47.5 MB | [E-npm] |
| Schema | `effect/Schema` in core since 3.10.0; `@effect/schema` deprecated | `Schema`, `SchemaAST`, `JsonSchema`, `StandardSchema` in core; `unstable/*` subpaths for ai, cli, cluster, http, rpc, sql, workflow, workers (Web Workers, not Cloudflare) | [E-schema-dep][M-v4-modules] |
| Requirements | — | "TypeScript 5.9 or newer", `strict: true` | [E-v4-readme] |
| Workers-specific platform package | none (`@effect/platform-browser` 0.77.1 is browser; `@effect/platform` 0.97.1 depends on `find-my-way-ts`, `multipasta`, `msgpackr`) | `@effect/sql-sqlite-do` (DO SQLite via `DurableObjectStorage`, transactions routed through `storage.transaction`), `@effect/sql-d1` | [E-platform-npm][E-sqlite-do][E-sqlite-do-cs] |

### 2.2 Bundle size (esbuild 0.28.2, `--bundle --minify --platform=browser --format=esm`, gzip -9)

| Program | 3.22.1 min / gz | 4.0.0-rc.112 min / gz | Notes |
|---|---|---|---|
| `Effect.runPromiseExit(Effect.succeed(1))` only | 199.7 KB / 65.5 KB | 82.8 KB / 29.0 KB | the fibre runtime floor |
| Effect + Layer + Stream + Schema + Scope + Schedule (Context tag, Layer.succeed, Schema.Struct decode, Stream.runCollect, acquireRelease, retry exponential, timeout) | 551.1 KB / 169.5 KB | 369.1 KB / 115.3 KB | v3 pulls in `fast-check` 36.7 KB + `pure-rand` 8.9 KB through Schema's Arbitrary |
| `Schema.Struct` decode only | 317.8 KB / 97.0 KB | 234.8 KB / 71.0 KB | what "replace zod" would cost |
| `zod` 4.5.4 (`import { z } from "zod"`) `z.object` parse | 433.4 KB / 86.9 KB | — | larger than the 61.8 KB bundlephobia figure in [PS §2.1]; 4.5.x ships `v4/core/compile.js` (28 KB) and JSON-Schema processors in the classic entry |
| `zod/mini` 4.5.4, same schema | 12.6 KB / 4.5 KB | — | the cheap path if core only needs parse + toJSONSchema |
| Plain-TS `Result` + `retry` + `withTimeout` + `AsyncDisposableStack` (section 5) | 0.9 KB / 0.5 KB | — | [M-plain] |

Cloudflare limits: "After compression (gzip) 3 MB" free, "10 MB" paid; "A Worker must parse and execute its global scope within 1 second"; 128 MB per isolate [CF-limits]. Every row fits; the point is relative weight and start cost, not the cap.

### 2.3 Cold start (workerd 2026-09-03, local, spawn → first HTTP 200, 4–5 runs each, port-collision outliers dropped)

hello world ≈ 115–124 ms; `Effect` only ≈ 130–140 ms; five-module Effect program ≈ 167–171 ms; `zod` ≈ 130–133 ms; `zod/mini` ≈ 122–124 ms [M-cold]. This includes process spawn, so only the deltas matter: ~+15 ms for the runtime, ~+45–50 ms for the full slice, ~+10 ms for zod. Production isolate start differs (V8 code cache, warm process), but the ordering is what it is; UNVERIFIED against Cloudflare's own numbers, which the docs do not publish per-script.

### 2.4 Runs on workerd

The five-module program ran in workerd 2026-09-03 and returned the expected result in 24 ms cold / 10 ms warm: Schema decode, `Stream.runCollect`, `Scope` finalizer ran on exit, `Fiber.interrupt` of a sleeping fibre reported `isInterrupted`, `retry(Schedule.exponential)` succeeded on the third attempt, `timeout` did not fire [M-run]. Node-global references in the bundle are all feature-detected: `process.hrtime` in `internal/clock.js`, `process.stdout` in `internal/logger.js` (pretty logger), `setImmediate` in `Micro.js` (`"setImmediate" in globalThis ? … : f => setTimeout(f, 0)`), and the `Scheduler` uses `setTimeout` [M-node-refs]. No `node:*` import, so [ADR-2] is not violated by the library itself. The one live issue is the module-scope timer throw fixed in #7930 (unreleased) [E-sched-fix].

### 2.5 Precedent (package.json checked 2026-09-03)

| Harness / library | `effect` present? | Evidence |
|---|---|---|
| Claude Code (`@anthropic-ai/claude-code` 2.1.259) | No — `dependencies: {}`; ships platform binaries; JS-era 1.0.0 and 2.0.0 also `{}` (bundled, source closed, so internals UNVERIFIED) | [P-cc] |
| Codex CLI (`@openai/codex` 0.153.0) | No — Rust binary; the legacy TS `codex-cli/package.json` on `alpha-cli` lists only `@vscode/ripgrep` | [P-codex] |
| pi (`@mariozechner/pi-agent-core` 0.73.1, `pi-ai`, `pi-coding-agent`; `badlogic/pi-mono` main `packages/agent`) | No — `typebox`, `pi-ai`, `chord`, `diff`, `ignore`, `yaml` | [P-pi] |
| `@cloudflare/think` 0.17.0 | No — AI SDK, `just-bash`, `@cloudflare/codemode`, peer `zod ^4` | [P-think] |
| `agents` 0.22.0 | No — `capnweb`, `cron-schedule`, `partysocket`, `@cfworker/json-schema`, peer `zod ^4`; grep of `packages/agents/package.json` and `packages/think/package.json` on `main` for `"effect` = 0 | [P-agents] |
| `@cloudflare/ai-chat` 0.11.0, `@cloudflare/sandbox` 0.12.9, `@modelcontextprotocol/sdk` 1.30.0, `ai` 7.0.91 | No | [P-aichat][P-sandbox][P-mcp][P-ai] |
| Alchemy 2 (`alchemy` 2.0.0-beta.76, "Infrastructure as Effects") | Yes — peers `effect >=4.0.0-rc.112`, `@effect/sql-d1`, `@effect/sql-sqlite-do`; a Node/Bun CLI that *deploys to* Cloudflare, not a Worker | [P-alchemy] |

Ecosystem shape: every harness and every Workers library karmi touches is zod-first (`agents`, Think, AI SDK, MCP SDK all peer on `zod ^4`) and Promise/AsyncIterable-first. Effect would be an island.

## 3. Runtime model vs the DO lifecycle

What Effect's runtime gives: fibres with structured interruption (a parent's interruption propagates to forked children, finalizers run) [E-fibers]; `Scope` with acquire/release ordering [E-scope]; `Schedule`-driven retry and `timeout` as combinators [E-retry][E-timeout]; typed error channels `Effect<A, E, R>`; `Layer` for dependency wiring [E-runtime].

What the DO lifecycle does to it [CF-lifecycle][CF-inmem]:

- **Hibernation (≥10 s idle, hibernatable WebSockets)**: "the in-memory state is discarded"; timers are not recreated. Any fibre parked on `Effect.sleep`, a retry back-off or a `Deferred` is gone without its finalizers. Hibernation only happens when "No request/event is still being processed" and no awaited `fetch()` is in flight, so a running Step blocks it — same as a plain Promise.
- **Eviction (70–140 s idle) and code deploys**: the object shuts down; in-flight storage access "will be stopped immediately and return an error". A model Step mid-stream dies either way; karmi recovers by re-running the Step from the log, and a tool Step by the read-only/idempotent rule [CONTEXT Step]. Effect's `Exit`/`Cause` would never be observed for that failure.
- **Alarm as watchdog**: the alarm is a persisted timer that survives all of the above [CF-alarms]; Effect has no persisted equivalent (`unstable/workflow` in v4 targets `@effect/cluster`, not DO alarms [M-v4-modules]).

So the region where Effect adds value is the inside of one Step in one invocation: run N read-only Tools concurrently, cancel the rest when the Turn is cancelled, bound each by `toolTimeoutMs`, retry a 429/529 on the model call, close an MCP session or Workspace at Turn end. That region is small, its lifetime is one `fetch`/`alarm` handler, and the web platform now covers it natively (section 5). The persisted checkpoints already make "what if we die halfway" a solved question at the layer above, which is precisely the question Effect's structured concurrency is best at answering in long-lived Node processes and that a DO answers by design.

## 4. The public-API façade

The ticket's constraint is that Effect must not leak into `define*`, `karmi.thread()`, Tool handlers or Hooks. Mechanically that is achievable:

- Inbound: every user-implemented seam becomes `Effect.tryPromise({ try: (signal) => handler(input, ctx, signal), catch: (e) => new ToolError(...) })`; the AbortSignal bridge exists on both sides (`Effect.tryPromise` passes a signal; `Effect.runPromise(e, { signal })` interrupts on abort [E-runPromise]).
- Outbound: `Provider.stream()` returns `AsyncIterable<ProviderEvent>` [PS §4]; internally `Stream.fromAsyncIterable` / `Stream.toAsyncIterable` at the seam.
- Errors: internal tagged errors (`Data.TaggedError`) flattened to the plain `{ isError, interrupted }` Tool result and `turn.failed` event shapes the log already defines; those are JSON, so no Effect type escapes.

The cost is one adapter per seam (Tool, Hook, Provider, Retriever, Deliverer, UsageHandler, MCP transport, Sandbox), a second vocabulary for every contributor, and `strict` + generator-style code throughout core. It does not double every type, but it does double every boundary, and the [AGENTS.md] test — "does it make the correct behaviour unsurprising for the developer using the framework?" — is answered by the façade being invisible, i.e. it buys the developer nothing.

## 5. The pains, and what plain TypeScript costs for each

All of the following were verified running in workerd 2026-09-03 with `compatibility_date 2026-08-04` and no flags [M-using][M-plain].

| Pain | Effect answer | Plain-TS answer | Cost |
|---|---|---|---|
| Cancel a tool batch when the Turn is cancelled / an Approval is denied | `Effect.all(…, { concurrency })` + fibre interruption | One `AbortController` per Turn; per-call `AbortSignal.any([turn.signal, AbortSignal.timeout(toolTimeoutMs)])`; Tool handlers receive `ctx.signal`. `AbortSignal.any` and `AbortSignal.timeout` are native in workerd. `Promise.allSettled` over the batch; a result that arrives after abort is discarded by the Step writer, not by the caller | ~20 lines; already the shape in [PS §4] (`signal?: AbortSignal`) |
| Typed errors on the Provider seam | `Effect<A, ProviderError, R>` | A discriminated union `ProviderError = { kind: "rate_limited" \| "overloaded" \| "auth" \| "invalid_request" \| "network" \| "aborted"; retryable: boolean; status?; providerCode? }` returned in a `Result<T, E>` or thrown as a single `class ProviderError` with that payload; exhaustiveness via `switch` on `kind` | ~40 lines; no runtime |
| Retry / timeout policy | `Schedule.exponential` + `Effect.retry` + `Effect.timeout` | `retry(fn, { attempts, baseMs, maxMs, signal, retryIf })` with jitter, abort-aware sleep; `withTimeout(fn, ms, parent)` via `AbortSignal.any`. Measured 0.5 KB gz including a `Result` type. `p-retry` exists but is Node-flavoured; not needed | ~40 lines, one file |
| Resource cleanup (MCP session, Workspace, presigned URL, Provider stream reader) | `Scope` / `acquireRelease` | `await using` + `AsyncDisposableStack` (TC39 explicit resource management, stage 4; TS 5.2+; shipped in V8 13.8 / Chrome 134; `Symbol.asyncDispose`, `DisposableStack`, `AsyncDisposableStack` all present in workerd unflagged, and `await using` inside a throwing function ran the disposer before the catch) | 0 lines of library; esbuild `--target=esnext` emits it natively, `es2024` down-levels it |
| Dependency wiring (Provider profile, secret store, Logger, Sandbox seam) | `Layer` / `Context` | Explicit constructor args — already the [ADR-2] rule ("Turn context is passed explicitly as an argument") | 0 |
| Streaming with back-pressure | `Stream` | `ReadableStream` / `AsyncIterable`; the Provider seam is already `AsyncIterable<ProviderEvent>` [PS §4] | 0 |
| Concurrency limit on read-only Tool batches | `{ concurrency: n }` | a 10-line semaphore, or run the batch unbounded (batches are model-sized, ≤ tens of calls) | ~10 lines |

The same caveat applies to both columns: none of it survives hibernation/eviction, and the Step log is what makes that acceptable. The plain column is ≈100 lines in a single `core/src/async.ts`, with zero dependencies and nothing to explain to a contributor who knows the web platform.

## 6. Schema

[ADR-2] fixes zod v4 as "the single schema library across the public API (Tool input, Agent Spec, ProviderConfig) with JSON Schema emitted for the wire". `effect/Schema` is a full peer: decode/encode, JSON Schema, Standard Schema bridge [M-v4-modules]. Using it internally while zod stays public means two schema runtimes in the bundle (+71–97 KB gz) and two ways to express a Tool input; replacing zod means walking away from the shape every neighbour uses (`agents`/Think/AI SDK/MCP SDK all peer on `zod ^4` [P-agents][P-think][P-ai][P-mcp]) and from `MCPAITool.inputSchema: z.ZodType` interop [agents-sdk §2]. Neither is v0. A side finding from the measurement: `zod` classic 4.5.4 is 87 KB gz whereas `zod/mini` is 4.5 KB for the same schema [M-bundle]; core should import `zod/mini` for its own internal parsing and let user code use whichever entry it likes (both produce the same `z.core` schema objects). Worth a line in the package-layout ticket.

## 7. Decision inputs for package layout and compatibility

- **`@karmi/core`: no `effect`.** Internals on Promises/AsyncIterables, `AbortSignal` trees, `await using`, a local `Result`/error-union, and one `async.ts` helper file. Keep `signal` as a first-class argument on every internal seam so cancellation is uniform.
- **Compatibility baseline unchanged**: `compatibility_date ≥ 2026-08-04` already gives native `AbortSignal.any/timeout` and explicit resource management; TypeScript ≥ 5.9 (ADR) covers `using`. Add "esbuild/tsdown `target: esnext` (or ≥ es2024 with down-level) for `using`" to the toolchain note.
- **Peripheral packages may use Effect** if a concrete need arrives (a Workflows-based Job runner; an Effect-native provider layer), in their own Worker, behind karmi's plain seams. This is the same rule [ADR-2] applies to `node:*`.
- **Re-check trigger**: Effect 4.0 stable with a documented Workers target and the #7930 scheduler fix released; or a karmi feature that needs supervised in-memory fan-out beyond a tool batch.

## 8. Sources

Measurements (all 2026-09-03, `/tmp/effect-measure`, esbuild 0.28.2, workerd 2026-09-03 via `npx workerd serve`)
[M-bundle]: `esbuild <entry>.ts --bundle --minify --platform=browser --format=esm --metafile`; gzip -9; entries: `min.ts` (Effect, Layer, Stream, Schema, Scope, Schedule, Context, Exit on 3.22.1), `min4.ts` (same on 4.0.0-rc.112 with `Context.Service`, `Layer.succeed(Cfg)(…)`, `Schema.decodeUnknownEffect`), `effect-only*.ts`, `schema-only*.ts`, `zod.ts`, `zodmini.ts`; metafile attribution: v3 five-module bundle = effect 504.9 KB + fast-check 36.7 KB + pure-rand 8.9 KB; v4 = effect 368.5 KB only
[M-cold]: `coldstart.sh` — spawn `workerd serve`, poll until first HTTP 200, 5 runs each; values in §2.3
[M-run]: `runtest.ts` bundled and served by workerd with `compatibilityDate = "2026-08-04"`; response `{"ms":24,"r":{"p":{"name":"x","age":1},"s":[1,2,3],"released":true,"interrupted":true,"retries":3}}`, second request `ms: 10`
[M-node-refs]: grep of the minified bundle and of `node_modules/effect/dist/esm/{Micro.js,Scheduler.js,internal/clock.js,internal/logger.js}` (3.22.1) — `process.hrtime`/`process.stdout` guarded by `typeof process === "object"`, `setImmediate` guarded by `"setImmediate" in globalThis`; no `node:` specifiers in either major's bundle
[M-using]: `using.ts` served by workerd → `{"has":{"asyncDispose":"symbol","dispose":"symbol","DisposableStack":"function","AsyncDisposableStack":"function"},"log":["body","disposed","caught"]}`
[M-plain]: `plain.ts` (Result, retry with jitter and abort-aware sleep, withTimeout via `AbortSignal.any`, `AsyncDisposableStack`) → 886 B min / 527 B gz; served by workerd → `{"r":{"ok":true,"value":1},"t":2}`
[M-v4-modules]: `ls node_modules/effect/dist` and `package.json` `exports` of 4.0.0-rc.112 — `Schema`, `SchemaAST`, `JsonSchema`, `StandardSchema`, `Result`, `Scope`, `Layer`, `Stream` in core; `./unstable/{ai,cli,cluster,devtools,encoding,eventlog,http,httpapi,observability,persistence,process,reactivity,rpc,schema,socket,sql,workflow,workers}`; `unstable/workers` exports `Worker`, `WorkerRunner`, `Transferable` (Web Workers)

Effect
[E-npm]: `npm view effect version license dist.unpackedSize dependencies dist-tags time` — `latest 3.22.1` (2026-07-30), `rc 4.0.0-rc.112` (2026-08-25), `beta 4.0.0-beta.107`; https://www.npmjs.com/package/effect
[E-schema-dep]: `npm view @effect/schema deprecated` → "this package has been merged into the main effect package"; `effect/dist/dts/index.d.ts` line 1156 `export * as Schema` with `@since 3.10.0`
[E-platform-npm]: `npm view @effect/platform-browser` (0.77.1, "Platform specific implementations for the browser"), `@effect/platform` (0.97.1; deps `msgpackr`, `multipasta`, `find-my-way-ts`)
[E-sqlite-do]: https://github.com/Effect-TS/effect/tree/main/packages/sql/sqlite-do (README: "An Effect SQL client for the SQLite storage in Cloudflare Durable Objects"; `npm view @effect/sql-sqlite-do` → 0.30.0, peers `effect ^3.22.0`, first published 2024-12-15)
[E-sqlite-do-cs]: `.changeset/pre/sqlite-do-durable-object-transactions.md` — "allowing `SqliteClient` to be configured with `DurableObjectStorage` and routing `withTransaction` through `storage.transaction`"
[E-readme]: https://github.com/Effect-TS/effect/blob/main/README.md package table (`@effect/sql-d1`, `@effect/sql-sqlite-do`)
[E-sched-fix]: `.changeset/scheduler-global-scope-timers.md`, commit 42fd969 2026-09-03T16:08Z "fix(Scheduler): fall back to a microtask when timers cannot be set (#7930)" — "Cloudflare Workers disallow timers in global scope, so an effect that yielded while running at module load failed with 'Disallowed operation called within global scope'"; `packages/effect/src/Scheduler.ts` now `try { setTimer(f) } catch { setMicrotask(f) }`; latest release on GitHub is `effect@4.0.0-rc.112` (2026-08-25), so unreleased
[E-v4-readme]: `node_modules/effect/README.md` (4.0.0-rc.112) — "TypeScript 5.9 or newer", "`strict` flag must be enabled", `npm install effect@rc`
[E-blog-rc]: https://effect.website/blog/releases/effect/40-rc ("We think we are ready to ship. Now it's your turn", 2026-08-12)
[E-blog-aug]: https://effect.website/blog/effect-v4-rc-august-recap (2026-08-31): "The `effect` core package has no external dependencies", "No broad breaking changes are planned for the RC cycle"
[E-runPromise]: `effect/dist/dts/Effect.d.ts` line 24422 `runPromise(effect, options?: { signal?: AbortSignal })`; https://effect.website/docs/runtime/
[E-fibers]: https://effect.website/docs/concurrency/fibers/ (interruption)
[E-scope]: https://effect.website/docs/resource-management/scope/
[E-retry]: https://effect.website/docs/error-management/retrying/
[E-timeout]: https://effect.website/docs/error-management/timing-out/
[E-runtime]: https://effect.website/docs/runtime/
[E-schema-docs]: https://effect.website/docs/schema/introduction/

Cloudflare
[CF-limits]: https://developers.cloudflare.com/workers/platform/limits/ — "After compression (gzip) 3 MB" (Free) / "10 MB" (Paid); "A Worker must parse and execute its global scope … within 1 second"; "up to 128 MB of memory"
[CF-lifecycle]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ — hibernation "After 10 seconds of no incoming request or event", "the in-memory state is discarded", `setTimeout`/`setInterval` not recreated, conditions "No in-progress awaited `fetch()`", "No request/event is still being processed"; eviction "After 70-140 seconds of inactivity"; on shutdown storage access "will be stopped immediately and return an error"; code updates "will cause a Durable Object to shut down"
[CF-inmem]: https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ — "in-memory state is not preserved across eviction or hibernation"
[CF-alarms]: https://developers.cloudflare.com/durable-objects/api/alarms/
[CF-node]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/

Web platform
[TC39-using]: https://github.com/tc39/proposal-explicit-resource-management ; https://v8.dev/features/explicit-resource-management (shipped Chrome 134 / V8 13.8) ; https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html (`using` declarations)

Precedent (checked 2026-09-03)
[P-cc]: `npm view @anthropic-ai/claude-code@{2.1.259,2.0.0,1.0.0} dependencies` → `{}` each; optional deps are `@anthropic-ai/claude-code-{platform}` binaries; `@anthropic-ai/claude-agent-sdk` 0.3.259 also no deps
[P-codex]: https://github.com/openai/codex/blob/main/codex-cli/package.json (no dependencies; `bin/codex.js` launcher for the Rust binary); `alpha-cli` tag `codex-cli/package.json` deps `@vscode/ripgrep` only; `npm view @openai/codex` 0.153.0 optional deps are platform binaries
[P-pi]: https://github.com/badlogic/pi-mono/blob/main/packages/agent/package.json (`@earendil-works/chord`, `pi-ai`, `pi-telemetry`, `diff`, `ignore`, `typebox`, `yaml`); `npm view @mariozechner/pi-agent-core` 0.73.1 (`typebox`, `pi-ai`), `pi-ai` (vendor SDKs, `typebox`, `zod-to-json-schema`), `pi-coding-agent`
[P-think]: https://github.com/cloudflare/agents/blob/main/packages/think/package.json ; `npm view @cloudflare/think` 0.17.0
[P-agents]: https://github.com/cloudflare/agents/blob/main/packages/agents/package.json ; `npm view agents` 0.22.0; `curl … | grep -c '"effect'` = 0 for both files
[P-aichat]: `npm view @cloudflare/ai-chat` 0.11.0 (`nanoid`)
[P-sandbox]: `npm view @cloudflare/sandbox` 0.12.9 (`hono`, `capnweb`, `aws4fetch`, `@cloudflare/containers`)
[P-mcp]: `npm view @modelcontextprotocol/sdk` 1.30.0 (peer `zod ^3.25 || ^4.0`)
[P-ai]: `npm view ai` 7.0.91 (peer `zod ^3.25.76 || ^4.1.8`)
[P-alchemy]: `npm view alchemy` 2.0.0-beta.76 ("Infrastructure as Effects for TypeScript"; peers `effect >=4.0.0-rc.112`, `@effect/sql-d1`, `@effect/sql-sqlite-do`, `@effect/platform-{node,bun}`); `@alchemy.run/cloudflare-runtime` deps (`workerd`, `unenv`, …) — a deploy-side tool, not Worker code
[E-community]: https://effect.website/blog issue #125 (2025-07-03) lists "Cloudflare Workers with Effect & RPC" as community content — not production evidence

Internal
[ADR-2]: docs/adr/0002-compatibility-baseline.md
[PS]: docs/research/provider-seam.md §2.1, §4
[agents-sdk]: docs/research/agents-sdk.md §2
[CONTEXT]: CONTEXT.md — Step, Turn, Job, Workspace, Approval
[AGENTS.md]: AGENTS.md core principles
