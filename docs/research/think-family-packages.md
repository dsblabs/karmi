# Think-family standalone packages: dependency decisions for karmi

Research note, 2026-08-30, answering GitHub issue #31. Primary sources only: the npm registry and published tarballs; `cloudflare/agents` source and release tags; the separate official `cloudflare/dynamic-workflows` repository; and Cloudflare product documentation. `cloudflare/agents` was read at `main` commit `8ffb3ad14a0aed72b047b8968981f10b141c700b` (2026-08-28); `cloudflare/dynamic-workflows` at `9726985af886698e85e90e3f044daf6dfcea2c1d` (2026-04-30). Published/source differences are called out rather than silently treating `main` as the npm artifact. Every external claim carries a bracket key from section 8; standing karmi decisions are cited as [CONTEXT], [ADR-2], [Agents], [RC], and issue resolutions [I9], [I13].

## 1. Recommendation

**Do not add any of the four packages as a karmi v0 runtime dependency. Vendor the narrow MIT-licensed one-shot execution mechanics from `@cloudflare/codemode`; borrow the workspace design from `@cloudflare/shell`; ignore `@cloudflare/worker-bundler` for the already-decided Script tiers; and ignore `@cloudflare/dynamic-workflows` for the `Job` seam.**

| Package | `scripts.isolate` (#9) | container/workspace (#26) | `Job` seam (#13) | Overall action now |
|---|---|---|---|---|
| `@cloudflare/codemode` | **Vendor (MIT), narrowly:** the Dynamic Worker source wrapper, RPC tool bridge, value codec, log capture, timeout and eager stub disposal. Keep karmi's `Sandbox` and `ToolBridge` types and add its own `cpuMs`, `wallMs`, `maxToolCalls`, Policy/Hook/Connection gate and Thread events. Do not vendor the AI adapters or durable runtime. | Ignore; it is an isolate executor, not a container/filesystem runtime. | Ignore its abort-and-replay runtime; its `cm_*` log would compete with the Thread event log and its pause model is not the `Job` protocol. | **Vendor a small audited subset at the release tag, with attribution; no package dependency.** |
| `@cloudflare/shell` | **Ignore:** #9 explicitly gives isolate scripts no filesystem or storage. | **Borrow the design:** a narrow filesystem interface, coarse operations, async-store-to-sync snapshot adapter, and large-file spill. Do not adopt its SQLite/R2 `Workspace` as container truth: it is a virtual JS filesystem, not Container/Sandbox disk, and would create a second file authority beside `MediaRef`/R2. | Ignore; it has no durable execution or progress/cancellation protocol. | **Borrow the interface ideas; do not depend or vendor.** |
| `@cloudflare/worker-bundler` | **Ignore:** #9 grants pure computation plus Tools, not arbitrary npm dependencies. Registry fetches and installed third-party code would enlarge the Capability and supply-chain/egress surface. If TypeScript syntax must be accepted, use a fixed transpiler in the host; do not expose `package.json`. | Ignore; a container already has its image and native package managers. Runtime npm bundling into a Dynamic Worker is the wrong tier. | Ignore; it has no job semantics. | **Ignore for v0. Reconsider only for a separately granted runtime-packages capability.** |
| `@cloudflare/dynamic-workflows` | Ignore; it gives a Dynamic Worker a Workflow binding and lets tenant code define durable steps, which is far beyond one bounded Script call. | Ignore; it does not manage containers, files, artifacts or process lifetime. | **Ignore:** it solves “N tenant-authored Workflow classes behind one deployed Workflow entrypoint.” karmi's Workflow, when implemented, is Framework-owned and sits behind `Job`; job code does not come from the isolate. | **Ignore. Use the native Workflow binding directly inside a future Cloudflare `Job` adapter.** |

This preserves the boundary fixed in [I9]: a v0 Script is one synchronous Dynamic Worker execution whose only authority is the allow-resolved Tool bridge. It also preserves [I13]: a Workflow never owns a Thread turn; a Tool returns `{ pending: jobId }`, and progress/completion re-enter the Thread as Events. None of these packages should introduce a second transcript, approval log, workspace authority or public Workflow API.

## 2. Version, stability, release and licence snapshot

As of 2026-08-30:

| Package | Published npm version | Explicit stability marker | Release history | Licence | Published artifact versus source |
|---|---:|---|---|---|---|
| `@cloudflare/codemode` | `0.5.1`, published 2026-07-27 | README and Cloudflare docs: **Experimental**, breaking changes possible, caution in production [CM-readme][CM-docs] | 30 versions from 2025-12-29 through 2026-07-27; 0.1.0 was a documented rewrite that removed the old API. Roughly four releases/month while active [CM-npm][CM-rewrite]. | MIT [CM-pkg] | Release tag `df88221`. At inspected `main`, package source is identical; only dev metadata changed (`@modelcontextprotocol/sdk` 1.29→1.30, Vitest removed) [CM-main-diff]. Thus the source behavior below also describes npm 0.5.1. |
| `@cloudflare/shell` | `0.4.3`, published 2026-07-23 | README: **Experimental**, “API surface is still settling — expect breaking changes” [SH-readme] | 19 versions from 2026-03-13 through 2026-07-23; four minor lines in four months, roughly four releases/month while active [SH-npm][SH-changelog]. | MIT [SH-pkg] | Release tag `402c1ca`. At inspected `main`, source is identical; only test dev-dependency versions changed [SH-main-diff]. |
| `@cloudflare/worker-bundler` | `0.2.3`, published 2026-08-18 | README: **Experimental**, API may change without notice, not recommended for production [WB-readme] | 11 versions from 2026-03-11 through 2026-08-18; three minor lines in five months, about two releases/month [WB-npm][WB-changelog]. | MIT [WB-pkg] | Release tag `bcf7eaf`; no package diff from inspected `main` [WB-main-diff]. |
| `@cloudflare/dynamic-workflows` | `0.1.1`, published 2026-04-30 | No “experimental” banner or support promise found. It is pre-1.0; source explicitly excludes underscore-prefixed internals from semver guarantees [DW-index]. | Only `0.1.0` and `0.1.1`, published 15 minutes apart on 2026-04-30; no later npm release and no repository commit after that day [DW-npm][DW-history]. This is not a demonstrated cadence. | MIT, copyright Dan Lapid [DW-license][DW-pkg] | Separate repository: `cloudflare/dynamic-workflows`, not `cloudflare/agents`. Npm `gitHead` is `c984c62`; current `main` differs only by one README package-name correction [DW-diff]. |

All four are therefore legally vendorable, but MIT permission is not a reason to vendor a mismatched abstraction. A vendored Codemode subset must retain the copyright/licence notice; no code from the other three is needed.

## 3. Dependency and build-surface audit

| Package / entrypoint | `agents` or `Lifecycle` | `ai` | decorators | `node:*` | Cloudflare/runtime coupling |
|---|---|---|---|---|---|
| Codemode root | No `agents` or `Lifecycle`. | Published root JavaScript does not import `ai`, but its root `.d.ts` imports `ToolSet` from `ai` and `ZodType`; both are optional peers. `/ai` imports `ai` + `zod`; `/tanstack-ai` imports TanStack AI + `zod`; `/mcp` imports MCP SDK + `zod` [CM-pkg][CM-dist]. | None. | Root none; `/vite` imports `node:path` [CM-dist]. The generated Dynamic Worker nevertheless explicitly sets `nodejs_compat`. | Root imports `DurableObject` and `RpcTarget` from `cloudflare:workers`; executor needs `WorkerLoader` [CM-executor][CM-dist]. |
| Shell root / subpaths | No production `agents` or `Lifecycle`; `Agent` appears only in examples/tests. Package has a runtime dependency on Codemode; `/workers` imports `CodemodeConnector` at runtime [SH-pkg][SH-dist]. | None directly. | None. | Root imports `node:diagnostics_channel`; its shared workspace chunk imports `node:crypto` [SH-dist][SH-fs]. | Workspace types accept DO SQLite, D1 or a custom SQL backend; optional R2. `/workers` is Codemode-shaped. |
| Worker Bundler | None. | None. | None. | No production `node:*` imports. Test/build scripts use Node, but not the published runtime path [WB-src][WB-dist]. | Runs only in workerd because it imports the Workers-loader-resolved `esbuild-wasm` module; package metadata nevertheless says `node >=22`. It fetches npm/PyPI metadata and tarballs from the host Worker [WB-readme][WB-installer]. |
| Dynamic Workflows | None; separate repo. | None. | None. | Published runtime none; build script uses Node [DW-src][DW-pkg]. | Imports `RpcTarget`, `WorkerEntrypoint`, `exports` and `WorkflowEntrypoint` from `cloudflare:workers`; needs both Worker Loader and Workflow bindings [DW-src][DW-docs]. |

The core compatibility consequence is narrower than “no Node anywhere.” [ADR-2] permits `nodejs_compat` as a runtime consequence of the date floor but forbids direct `node:*` imports in karmi core and decorators in public APIs. Codemode's one-shot mechanics satisfy that if vendored without `/vite`, although its generated child currently hard-codes `compatibilityDate: "2025-06-01"` plus `nodejs_compat`; karmi should instead apply its own date floor. Worker Bundler and Dynamic Workflows also avoid runtime `node:*`; Shell does not satisfy the core rule as published. None requires decorators or `agents/lifecycle`.

## 4. Persistence and caller assumptions

### 4.1 `@cloudflare/codemode`

The package contains two materially different products:

1. **The one-shot `DynamicWorkerExecutor` is stateless.** It normalizes the model's async-arrow-function code, generates an `executor.js` `WorkerEntrypoint`, loads a new Dynamic Worker, passes one `RpcTarget` dispatcher per Tool namespace, defaults `globalOutbound` to `null`, races execution against a timeout, captures console output, and disposes both entrypoint and Worker stubs in `finally` [CM-executor]. It can be called from an ordinary Worker or a DO; the caller need not be a DO. It creates no table and owns no persistent state.
2. **`CodemodeRuntime` is a separate durable abort-and-replay engine.** It extends `DurableObject` and creates `cm_executions`, `cm_log`, and `cm_snippets` in its facet's SQLite database. Every connector call/explicit `codemode.step` is logged; approval pauses abort the run; resume re-executes the code and serves prior calls from the log. `createCodemodeRuntime` requires a `DurableObjectState` and accesses this facet through the caller's `ctx`; stale runs must be expired from a recurring alarm/scheduled task [CM-runtime][CM-handle]. This path assumes a DO host and adds its own execution/audit/approval state.

Only (1) fits #9. Even then, karmi cannot use the package contract unchanged:

- `globalOutbound: null` and the RPC bridge match the decision exactly.
- Codemode exposes configurable wall timeout, but karmi also promises `cpuMs` and `maxToolCalls`; those must be enforced outside/inside the vendored bridge.
- Codemode catches Tool exceptions and serializes results, but karmi requires every nested call to re-enter its Policy, Hooks, Connection resolver and Thread log, and requires child events plus a compact summary [I9]. The vendored dispatcher must call karmi's `ToolBridge`, not Codemode connectors.
- Codemode accepts injected modules and arbitrary bindings; karmi's adapter must not expose those options through `run_script`.
- Codemode's code normalizer accepts JavaScript syntax; it is not a TypeScript compiler. “JS/TS” in [I9] therefore needs either prompt discipline (“emit executable JS”) or one fixed transpilation step, not Worker Bundler's open-ended package installer [CM-normalize].

The durable runtime conflicts with karmi rather than filling a gap: `cm_log` duplicates Thread events; its approval semantics expose actions that #9 explicitly withholds from scripts; replay re-runs the whole code body whereas karmi's Step recovery re-runs only unfinished Tools; and snippets are a new persisted primitive not in the v0 model [CONTEXT][I9][I13].

### 4.2 `@cloudflare/shell`

Despite the name, current Shell is **not Bash**. Its README says it does not parse shell syntax, expose pipes or emulate POSIX; it runs JavaScript against a typed `state` object [SH-readme]. It offers:

- `InMemoryFs`, which is ephemeral and needs no DO;
- `Workspace`, which accepts DO `SqlStorage`, D1, or a custom `{query, run}` backend, so the caller need not technically be a DO;
- one lazily-created table named `cf_workspace_${namespace}` plus a parent-path index; file contents below the default 1,500,000-byte threshold are inline, while larger files optionally spill to R2 under `${r2Prefix}/${namespace}${path}` [SH-fs];
- Codemode `state.*` and git ToolProviders/connectors; and
- `createFileSystemSnapshot`-like patterns for crossing between async durable storage and consumers that expect a filesystem [SH-readme][WB-fs].

This is a durable *virtual* filesystem. It does not persist a Container/Sandbox filesystem, define `sleepAfter`, survive container eviction by snapshotting disk, execute shell/Python, emit `MediaRef`s, or implement egress policy. Depending on it for #26 would answer the wrong question and put file bytes in a second store that karmi would then need to reconcile with container disk and the Thread's R2 artifacts.

The ideas worth borrowing are the narrow filesystem interface, coarse operations (`glob`, tree summaries, batched edits) to avoid chatty RPC, explicit inline/spill threshold, namespace validation, and a snapshot adapter. In karmi those should sit behind a container workspace synchronizer whose durable external representation is Scope-prefixed R2/`MediaRef`, not a package-owned `cf_workspace_*` table [CONTEXT].

### 4.3 `@cloudflare/worker-bundler`

`createWorker` consumes an in-memory or caller-supplied synchronous `FileSystem`, fetches npm (and Python) registry metadata/tarballs, installs dependencies into that filesystem, transforms or bundles with Sucrase/esbuild-wasm, and returns `{mainModule, modules, wranglerConfig?, warnings?}` ready for Worker Loader [WB-index][WB-installer][WB-docs]. It does not itself call Worker Loader.

The default path has no durable state and requires no DO. Optional `DurableObjectRawFileSystem` and `DurableObjectKVFileSystem` store files as DO KV keys under `bundle/`; the latter buffers writes until `flush()`. These are caller-selected stores, not tables or automatic persistence. `createFileSystemSnapshot` bridges an async source (the README names a SQLite/R2 Workspace) into an in-memory synchronous filesystem [WB-fs].

The package is useful for a platform that accepts a source tree plus `package.json` and wants a full Dynamic Worker. It is deliberately much more authority than karmi's isolate Script:

- dependency installation causes host-side registry egress even if the final Dynamic Worker has `globalOutbound: null`;
- npm packages execute inside the sandbox with the same Tool bridge and may add substantial CPU/memory/bundle size;
- resolving version ranges at run time makes execution dependent on mutable registry state unless karmi adds lockfile/integrity policy and a cache;
- the published tarball is 26 MB unpacked and includes esbuild-wasm/TypeScript machinery [WB-npm]; and
- the package itself says not to use it in production yet [WB-readme].

None of that is authorized by [I9]. Containers already solve the package/runtime problem in their own tier, so it is not useful there either. If karmi later adds `scripts.packages` as a separately granted Capability, this package becomes a candidate behind a new seam with registry allow-lists, exact versions/integrity, cached bundles, bundle-size limits and egress accounting; it should not be smuggled into v0 as “TypeScript support.”

### 4.4 `@cloudflare/dynamic-workflows`

This package lives in its own official repository. It solves one precise Workers-for-Platforms-style problem: a deployed Workflow binding names one static `WorkflowEntrypoint`, but a platform wants a different tenant-authored Workflow implementation in each Dynamic Worker [DW-readme][DW-docs]. It:

- wraps a real `Workflow` binding in a `WorkerEntrypoint` RPC stub;
- envelopes `create`/`createBatch` params as `{__dispatcherMetadata, params}`;
- relies on Workflows to persist that payload;
- unwraps the metadata when the static Workflow entrypoint runs, reloads the matching Dynamic Worker, and forwards `run(event, step)` to its `WorkflowEntrypoint`; and
- wraps returned `WorkflowInstance`s in `RpcTarget` because the native binding/instance cannot cross the Dynamic Worker boundary [DW-src].

It creates no SQLite table, KV key or R2 object. The caller need not be a DO; it must be a dispatcher Worker with a Workflow binding, `cloudflare:workers` exports, and normally a Worker Loader. Its persistence assumption is entirely the native Workflow engine's persisted event payload. The README warns that metadata is visible through status and must contain routing hints, not secrets [DW-readme].

This is not a generic Workflow helper and not a generic `Job` adapter. Adopting it would let isolate code create arbitrary long-lived Workflow runs and define their step graph, waits and side effects. That violates both decisions: isolate scripts are bounded and synchronous [I9], while Workflows are hidden behind Framework-owned `Job` implementations and never drive Thread turns [I13]. Karmi already keys internal resources by Scope; it does not load tenant-authored Workflow classes. The native Workflow binding is sufficient for a future `CloudflareJobRunner` whose one deployed Workflow class executes karmi's known job kinds and sends `job.progress`/`job.completed` Events back to the Thread.

## 5. Resulting designs for the three seams

### 5.1 `scripts.isolate`

Vendor only the mechanisms necessary to implement this internal adapter:

```ts
class DynamicWorkerSandbox implements Sandbox {
  run(req: {
    code: string;
    tools: ToolBridge;
    limits: ScriptLimits;
    scope: ScopeId;
    threadId: string;
    callId: string;
  }): Promise<ScriptResult>;
}
```

The implementation may trace back to Codemode 0.5.1's `DynamicWorkerExecutor`, codec and generated proxy, but karmi owns the contract. Hard-code `globalOutbound: null` and karmi's compatibility-date floor; do not copy Codemode's stale `2025-06-01` date plus explicit `nodejs_compat`; do not accept caller modules/bindings; expose only allow-resolved Tools; count calls before dispatch; route every call through the Harness; cap serialized input/output and logs; dispose RPC/native handles; map failures to karmi's named limit errors; and preserve Codemode's MIT notice [CM-executor][ADR-2][I9].

Do not vendor `createCodeTool`, AI/TanStack/MCP entrypoints, connectors, `CodemodeRuntime`, snippets, approval/revert/step replay, browser iframe support or Vite plugin. This keeps AI SDK, Zod, MCP SDK, `node:path`, decorators and package-owned SQL out of the isolate path.

### 5.2 container/workspace

The durable truth should remain a karmi-owned Scope-prefixed R2 representation surfaced as `MediaRef`; a live container filesystem is an execution cache/work area with an explicit lifetime. Borrow Shell's interface-level lessons, not its store. #26 still must decide when files are synchronized, conflict behavior, whether a Thread gets one container identity, and cancellation/progress for long runs. These packages supply none of those answers [SH-fs][I13].

For a short synchronous container call, the Tool Step may await the Sandbox adapter within its wall limit. A call that exceeds that limit starts a `Job`; the container runner emits coarse progress and exports selected files to R2 before sending completion. This is the same seam whether the implementation later uses Cloudflare Sandbox, another container service, or a local Docker test double [CONTEXT][I13].

### 5.3 `Job`

Implement `Job` without a public Workflow-shaped API:

```ts
interface JobRunner<I> {
  start(input: I): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
}
```

A Cloudflare adapter may call a native Workflow binding; the Workflow receives a small karmi job envelope (Scope, Thread key, tool-call id, job kind, payload/R2 refs), performs known Framework steps, and reports through `karmi.thread(key).send`. No tenant code, Dynamic Worker loader, or `@cloudflare/dynamic-workflows` routing metadata is involved. Keep Cloudflare Workflow instance IDs private to the adapter and map them to karmi `jobId`s so another runtime can implement the same seam [I13].

## 6. Why “depend” loses to “vendor/borrow” here

`@cloudflare/codemode` is the closest fit, and Cloudflare now documents it directly. A package dependency would still expose an experimental 0.x API that had 30 releases in seven months, a documented full rewrite, optional peer types leaking into the root declarations, a public root that bundles both the one-shot executor and a DO-backed persistence model, and knobs karmi must suppress [CM-npm][CM-rewrite][CM-dist]. Vendoring a narrow subset makes the security boundary reviewable and lets karmi pin behavior independently of Cloudflare's Think/connector roadmap. The cost is attribution and consciously porting upstream fixes; record the upstream tag/SHA beside the vendored code and periodically diff only those source files.

Shell and Worker Bundler are larger mismatches. Vendoring them would import an entire virtual filesystem or runtime package manager when only interface ideas might survive #26. Dynamic Workflows is small, but its size is irrelevant: its purpose is executing tenant-defined Workflow classes, the exact capability karmi has decided not to expose.

## 7. Re-evaluation triggers

1. **Codemode:** reconsider a dependency after a stable major/support statement, a framework-neutral executor-only export whose root declarations do not reference optional AI peers, and limits/hooks sufficient for karmi's `Sandbox` contract. Until then, monitor security/correctness changes to the vendored executor/codec files.
2. **Shell:** reconsider only if #26 chooses a durable virtual workspace as the canonical filesystem rather than container disk + R2 artifacts, and if the package offers a core-safe entrypoint without direct `node:*` or Codemode coupling.
3. **Worker Bundler:** reconsider only after a new Capability explicitly grants runtime dependencies, with exact-version/integrity, registry-egress and bundle-size policy. Its experimental marker must also be removed for a direct dependency.
4. **Dynamic Workflows:** reconsider only if karmi later hosts tenant-authored Workflow definitions in Dynamic Workers. Ordinary Framework-owned Jobs are not that case.

## 8. Sources

Karmi decisions

[CONTEXT]: ../../CONTEXT.md (Script, Capability, Thread, Step, Job, MediaRef and Scope definitions)
[ADR-2]: ../adr/0002-compatibility-baseline.md (date floor; no direct `node:*` in core; no decorators)
[Agents]: ./agents-sdk.md (build beside; Project Think addendum; Codemode inventory)
[RC]: ./runtime-comparison.md (Dynamic Workers for isolate; do not depend on API stability; Containers for the second tier)
[I9]: https://github.com/dsblabs/karmi/issues/9 (resolution: bounded synchronous Dynamic Worker, no filesystem/egress/secrets/storage, only gated Tools)
[I13]: https://github.com/dsblabs/karmi/issues/13 (resolution: DO owns turns; Workflows only behind `Job`; progress/completion re-enter as Events)

Npm registry and release artifacts

[CM-npm]: https://registry.npmjs.org/@cloudflare%2fcodemode (0.5.1; full version/time map; MIT; dependencies, peers and tarball metadata)
[SH-npm]: https://registry.npmjs.org/@cloudflare%2fshell (0.4.3; full version/time map; MIT; dependencies and tarball metadata)
[WB-npm]: https://registry.npmjs.org/@cloudflare%2fworker-bundler (0.2.3; full version/time map; MIT; 26,041,798-byte unpacked artifact)
[DW-npm]: https://registry.npmjs.org/@cloudflare%2fdynamic-workflows (0.1.1; two-version time map; npm `gitHead`; separate repository URL)

`cloudflare/agents` release tags and inspected `main`

[CM-pkg]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/package.json
[CM-readme]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/README.md
[CM-executor]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/src/executor.ts
[CM-runtime]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/src/runtime.ts
[CM-handle]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/src/runtime-handle.ts
[CM-normalize]: https://github.com/cloudflare/agents/blob/df882216b8b7af1a1ac96cb2ad4f5e13e4978c76/packages/codemode/src/normalize.ts
[CM-dist]: https://www.npmjs.com/package/@cloudflare/codemode/v/0.5.1?activeTab=code (published entrypoints; runtime and declaration imports verified from the registry tarball)
[CM-main-diff]: https://github.com/cloudflare/agents/compare/%40cloudflare%2Fcodemode%400.5.1...8ffb3ad14a0aed72b047b8968981f10b141c700b
[CM-rewrite]: https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/
[CM-docs]: https://developers.cloudflare.com/agents/tools/codemode/

[SH-pkg]: https://github.com/cloudflare/agents/blob/402c1ca2b5aba3e3d65abf5d985428972e46c940/packages/shell/package.json
[SH-readme]: https://github.com/cloudflare/agents/blob/402c1ca2b5aba3e3d65abf5d985428972e46c940/packages/shell/README.md
[SH-fs]: https://github.com/cloudflare/agents/blob/402c1ca2b5aba3e3d65abf5d985428972e46c940/packages/shell/src/filesystem.ts
[SH-dist]: https://www.npmjs.com/package/@cloudflare/shell/v/0.4.3?activeTab=code (published entrypoints; imports verified from the registry tarball)
[SH-changelog]: https://github.com/cloudflare/agents/blob/402c1ca2b5aba3e3d65abf5d985428972e46c940/packages/shell/CHANGELOG.md
[SH-main-diff]: https://github.com/cloudflare/agents/compare/%40cloudflare%2Fshell%400.4.3...8ffb3ad14a0aed72b047b8968981f10b141c700b

[WB-pkg]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/package.json
[WB-readme]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/README.md
[WB-index]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/src/index.ts
[WB-installer]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/src/installer.ts
[WB-fs]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/src/file-system.ts
[WB-src]: https://github.com/cloudflare/agents/tree/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/src
[WB-dist]: https://www.npmjs.com/package/@cloudflare/worker-bundler/v/0.2.3?activeTab=code (published entrypoints; imports verified from the registry tarball)
[WB-changelog]: https://github.com/cloudflare/agents/blob/bcf7eaf34ce3244e6f0272fd90c0dfb82ee9e0d0/packages/worker-bundler/CHANGELOG.md
[WB-main-diff]: https://github.com/cloudflare/agents/compare/%40cloudflare%2Fworker-bundler%400.2.3...8ffb3ad14a0aed72b047b8968981f10b141c700b
[WB-docs]: https://developers.cloudflare.com/dynamic-workers/getting-started/#using-typescript-and-npm-dependencies

Separate `cloudflare/dynamic-workflows` repository

[DW-pkg]: https://github.com/cloudflare/dynamic-workflows/blob/c984c62a5280a0f7758fa2556d8511de1f38e67a/packages/dynamic-workflows/package.json
[DW-readme]: https://github.com/cloudflare/dynamic-workflows/blob/9726985af886698e85e90e3f044daf6dfcea2c1d/packages/dynamic-workflows/README.md
[DW-index]: https://github.com/cloudflare/dynamic-workflows/blob/9726985af886698e85e90e3f044daf6dfcea2c1d/packages/dynamic-workflows/src/index.ts
[DW-src]: https://github.com/cloudflare/dynamic-workflows/tree/9726985af886698e85e90e3f044daf6dfcea2c1d/packages/dynamic-workflows/src
[DW-license]: https://github.com/cloudflare/dynamic-workflows/blob/9726985af886698e85e90e3f044daf6dfcea2c1d/LICENSE
[DW-history]: https://github.com/cloudflare/dynamic-workflows/commits/main/
[DW-diff]: https://github.com/cloudflare/dynamic-workflows/compare/c984c62a5280a0f7758fa2556d8511de1f38e67a...9726985af886698e85e90e3f044daf6dfcea2c1d
[DW-docs]: https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/
