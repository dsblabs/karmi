# Runtime comparison: is Cloudflare the right base for karmi?

Research note, 2026-08-28. Primary sources only (official docs, pricing pages, changelogs, source repos). Every number cites the page it was read from; anything not verifiable from a primary source is flagged. Date-sensitive: several products changed status in 2026 (Cloudflare Containers/Sandbox GA Apr 2026, Vercel Workflows GA Apr 2026, Dynamic Workers open beta Mar 2026, DO SQLite/Workflows step billing switched on in 2026, Lambda MicroVMs Jun 2026, Deno Deploy Classic sunset Jul 2026).

## 1. Summary and recommendation

**Yes: Cloudflare is the right base runtime for karmi v0.** The core is Durable Objects (DO) with SQLite storage, and everything else hangs off it.

Key reasons:
- DO is the only serverless primitive in this comparison that gives *per-session single-writer state + transactional local SQLite + hibernating WebSockets + a per-object alarm* in one addressable object [DO-lifecycle][DO-storage][DO-ws][DO-alarms]. That is exactly a Harness session. Vercel/AWS/Deno need three or four services glued together to approximate it; Fly/Modal give you a VM/container with no durable-state primitive.
- No wall-clock cap on an HTTP/WebSocket-driven Worker or DO "as long as the client remains connected" [W-limits]; CPU is the constraint (30 s default, 5 min configurable) and model I/O wait is free. Multi-hour loops span steps via Workflows (sleep up to 365 days, wall clock per step unlimited) or DO alarms [WF-limits][DO-alarms].
- Idle cost is near zero: hibernated DOs are not billed for duration, stored data is $0.20/GB-month after 5 GB [DO-pricing]; sleeping Workflows incur no CPU [WF-pricing].
- Sandboxes exist at two weights: Dynamic Workers (isolate, ms startup, open beta) and Containers/Sandbox SDK (GA Apr 2026) [DW-beta][CT-GA].
- Local dev fidelity is the best of the group: workerd is the open-source production runtime (Apache-2.0), Miniflare/Vitest run tests inside it, DOs/Workflows/Queues/Containers emulate locally [workerd][Vitest][W-local].
- Workers for Platforms gives per-Scope isolates with per-tenant CPU/subrequest caps, and AI Gateway gives BYOK, caching, logging and fallbacks in front of Anthropic/OpenAI [WfP][AIG-feat].

Main risks: 128 MB isolate memory [W-limits]; 15-minute wall-clock cap on alarm/queue/cron handlers [W-limits]; hibernation clears in-memory state and outbound WebSockets never hibernate [DO-ws][DO-lifecycle]; DO SQLite is single-region-of-record (no read replicas); lock-in of the DO/Workflows/Containers *programming model* even though the runtime is open source (workerd DOs are single-process and `localDisk` storage is "EXPERIMENTAL") [workerd-capnp]; Sandbox SDK 1.0 API still in preview [SB]; Dynamic Workers still beta [DW-beta].

## 2. Cloudflare features the v0 spec should assume

| Feature | Role in karmi | Status | Hard limits that shape the design | Source |
|---|---|---|---|---|
| **Workers** (Paid plan, $5/mo) | Entry point, channel adapters, routing to DO | GA | CPU 30 s default / 5 min max per invocation; **no wall-clock limit while client connected**; 128 MB memory; 6 simultaneous outbound connections; 10,000 subrequests; 10 MB compressed script; `waitUntil` 30 s after response; 15 min wall clock for cron, queue, alarm handlers | [W-limits][W-pricing] |
| **Durable Objects, SQLite backend** | The **session**: single-writer state, transcript, tool results, scheduler table | GA (SQLite "moved from beta to general availability"; KV backend no longer creatable) | 10 GB per object; 2 MB max row/string/BLOB; 100 bound params/query; 30 s default / 5 min CPU; soft 1,000 req/s per object; writes with no intervening `await` are coalesced atomically; `transactionSync()` for explicit; 30-day point-in-time recovery; one active instance per ID globally | [DO-limits][DO-storage][DO-overview][DO-state] |
| **DO lifecycle / hibernation** | Cost model for idle sessions | GA | Hibernates after **10 s** idle if no timers, no in-flight fetch, no outbound WS/TCP; otherwise evicted after 70-140 s; in-memory state lost on both; hibernatable idle DOs "are not billed for duration, even before the runtime has hibernated them" | [DO-lifecycle][DO-pricing] |
| **DO Hibernatable WebSockets** | Streaming to clients; multi-client fan-out per session | GA | Server-side only ("Outgoing WebSockets do not hibernate"); attachments survive only while socket healthy; 32 MiB max inbound message; deploys disconnect all sockets; "thousands of clients per instance" | [DO-ws][DO-limits] |
| **DO Alarms** | Wakeups, delayed resume, scheduler tick | GA | **One alarm per object**; at-least-once; retries exp. backoff from 2 s, max 6; may be delayed up to ~1 min; 15 min wall clock per handler; new `ctx.abort()` option to stop retries (Aug 2026) | [DO-alarms][DO-storage][W-limits][CF-changelog] |
| **Workflows** | Spanning long agent loops across steps; human-in-the-loop waits | GA (Apr 7 2025) | Wall clock per step **unlimited**; CPU per step 30 s default / 5 min; sleep up to 365 days; `waitForEvent` timeout 24 h default, up to 365 days; 1 MiB step result / event payload; 10,000 steps (25,000 configurable); 1 GB persisted state; 50,000 concurrent instances; state retained 30 days; step + storage billing started Aug 10 2026 | [WF-limits][WF-events][WF-GA][WF-pricing] |
| **Queues** | Channel ingress buffering, fan-out, delayed messages | GA | 128 KB message; delay max 24 h; 15 min consumer wall clock; 100 msg batch; 14-day retention; 250 concurrent push consumers; 100 retries | [Q-limits] |
| **Workers for Platforms** | Scope isolation when karmi hosts third-party or generated code per tenant | GA, $25/mo | User Workers run in "untrusted mode", never share cache; dispatch Worker sets per-customer `cpuMs` and subrequest limits; unlimited scripts; 30 s CPU per invocation (15 min cron/queue); outbound Worker for egress control | [WfP][WfP-how][WfP-pricing][WfP-limits] |
| **AI Gateway** | Model gateway: BYOK, caching, rate limits, retries/fallbacks, logs, spend limits, DLP, guardrails | GA, core free | Providers incl. Anthropic, OpenAI, Gemini; 10M persistent logs/gateway on Paid; 5% fee only on Unified Billing credits | [AIG][AIG-feat][AIG-pricing] |
| **Containers + Sandbox SDK** | Heavy code-execution Capability (shell, Python, git, ports) | **GA Apr 13 2026** (SDK 1.0 API in preview on `@next`) | Instance types lite (1/16 vCPU, 256 MiB, 2 GB) to standard-4 (4 vCPU, 12 GiB, 20 GB); 1,500 concurrent vCPU / 6 TiB memory per account; disk ephemeral ("Snapshots are coming soon"); cold start 1-3 s; one container per DO; `sleepAfter`; billed only while awake, CPU by active usage | [CT-GA][CT-limits][CT-pricing][CT-faq][DO-container][SB] |
| **Vitest integration + Miniflare + workerd** | Test runner and CI | GA | Tests run inside workerd; DO, KV, R2, D1, Queues, Workflows, Containers (needs Docker) emulate locally; Vectorize/Workers AI need remote bindings; DO+WebSockets unsupported under per-file storage isolation; no V8 coverage | [Vitest][Vitest-issues][W-local][WF-local][CT-local] |

Pricing anchors (Workers Paid): 10M requests + 30M CPU-ms included, then $0.30/M requests, $0.02/M CPU-ms [W-pricing]. DO: $0.15/M requests, $12.50/M GB-s, $1.00/M rows written, $0.001/M rows read, $0.20/GB-month [DO-pricing]. Workflows: $0.80/100K steps, $0.20/GB-month [WF-pricing]. Containers: $0.000020/vCPU-s active, $0.0000025/GiB-s, $0.00000007/GB-s disk [CT-pricing].

## 3. Cloudflare features NOT to assume in v0

- **Dynamic Workers (Worker Loader)** as the *default* sandbox. Open beta (Mar 24 2026), pricing announced ($0.002/unique Worker/day, waived in beta); `globalOutbound: null` blocks egress; helper libs `@cloudflare/codemode`, `worker-bundler`, `shell` [DW][DW-beta]. Design the Capability interface so it can be swapped in; do not depend on its API stability.
- **Sandbox SDK 1.0 API** (`@cloudflare/sandbox@next`): preview; GA'd product is the current stable line. Bind to a thin adapter [SB].
- **Workers KV** for session state: eventually consistent, ~60 s propagation, read-heavy [KV]. Fine for config/prompt caches, wrong for transcripts.
- **D1** as per-session store: 10 GB/DB, 30 s query cap, and it is a shared regional DB, not co-located with the session [D1]. Use DO SQLite; use D1 only for cross-session catalogues.
- **Vectorize / Workers AI**: no local simulation (remote bindings only) [W-local]; Workers AI is open models, not Claude/GPT [WAI]. Keep memory/retrieval as an optional Primitive.
- **Cloudflare Agents SDK** (`agents` npm, MIT): a reference implementation of exactly karmi's model (Agent extends DurableObject; SQL, `schedule()` on alarms + SQLite table, hibernating WS, MCP) [Agents-gh][Agents-sched]. Read it, borrow patterns, but no GA/versioning statement on the docs page [Agents]; do not build karmi's public API on top of it.
- **Container snapshots / persistent disk**: "All disk is ephemeral" today [CT-faq].
- **Cron Triggers** for per-session scheduling: 250 per account, minute granularity [W-limits-2]; only for fleet-wide housekeeping.

## 4. Comparison matrix

| Dimension | Cloudflare | AWS Lambda + Step Functions + DynamoDB | Vercel Functions + Workflow | Deno Deploy | Fly Machines | Modal |
|---|---|---|---|---|---|---|
| 1. Long loops / timeouts | No wall cap while client connected; CPU 5 min max; 15 min for alarm/queue/cron [W-limits]. Workflows: step wall unlimited, sleep 365 d [WF-limits] | Lambda 15 min hard; 10 GB mem [L-quotas]. SFN Standard 1 yr, 25,000 events; Express 5 min; 256 KiB state [SFN-quotas]. Durable functions (checkpoint/replay) up to 1 yr, waits free [L-durable] | 300 s default, 800 s GA max, 1800 s beta [V-limits]. Workflows: run/sleep "No limit", replay 240 s, steps 10,000 [V-WF-price] | App stays alive 5 s-10 min after last traffic; evictions possible mid-request [D-runtime]; billed on active CPU hours [D-price] | VM; no invocation timeout documented [F-over] | Function timeout up to 24 h, default 300 s [M-timeout]; web endpoints 150 s HTTP cap w/ 303 redirect trick [M-web-timeout] |
| 2. Durable per-session state | DO: single active instance per ID, 10 GB SQLite, atomic coalesced writes, PITR 30 d, hibernation [DO-lifecycle][DO-storage] | DynamoDB: no per-session actor; $0.125/M RRU, $0.625/M WRU, $0.25/GB-mo [DDB]. AgentCore Runtime: microVM per session, 8 h, 1 GB session FS [AC-quotas] | No actor primitive; Workflow run = event log (2 GB/run, retention 7 d Pro) [V-WF-price] | KV storage billed per GiB; "Databases" replace KV; no actor [D-price][D-deploy] | Machine = VM w/ volume ($0.15/GB-mo); suspend <=2 GB [F-price][F-suspend] | Dicts/Queues (ephemeral or named); Sandbox FS snapshots 30 d [M-dq][M-snap] |
| 3. Streaming | WS server w/ hibernation; 32 MiB msg; SSE via streamed Response [DO-ws][W-ws] | Function URL streaming 200 MB, 2 MBps after 6 MB, Node only; billed full duration [L-stream]. API GW WS: 2 h max, 10 min idle [APIGW-ws] | WS public beta (Jun 22 2026), billed active CPU only [V-ws]; Workflow streams resumable via `getReadable({startIndex})` [V-WF-stream] | `Deno.upgradeWebSocket`; WS activity keeps app alive [D-runtime] | Any protocol (VM) [F-over] | WS on all web decorators, 2 MiB frames, unlimited response body [M-web] |
| 4. Scheduling / wakeups | 1 alarm per DO, at-least-once [DO-alarms]; Queues delay 24 h [Q-limits]; Workflows sleep 365 d, waitForEvent [WF-events]; cron 250/acct [W-limits-2] | SFN Wait up to 1 yr; EventBridge/SQS (not verified here); durable waits free [L-durable] | Queues delay up to 7 d (TTL-capped), 100 MB msg [V-Q-price]; Workflow sleep/hooks unlimited [V-WF] | `Deno.cron` minute granularity, 10 jobs free/unlimited paid; Queues "Not supported" on new Deploy [D-cron][D-deploy] | None built in; run your own | Cron/Period schedules; no one-off delay documented [M-cron] |
| 5. Code sandboxes | Dynamic Workers (isolate, ms, beta) [DW-beta]; Containers/Sandbox SDK GA, lite 1/16 vCPU-standard-4 4 vCPU [CT-limits] | Lambda MicroVMs (Jun 2026): Firecracker, 8 h max, suspend/resume, $0.0000277/vCPU-s [L-microvm][L-pricing]; AgentCore Code Interpreter 2 vCPU/8 GB, 8 h [AC-quotas] | Vercel Sandbox GA: Firecracker, 24 h/session (Pro), up to 8 vCPU/16 GB, $0.128/CPU-h, 10,000 concurrent [V-SB-price] | Deno Sandbox: microVM, 2 vCPU/1.2 GiB default, 30 min max, 3-20 concurrent per region, pre-release [D-SB][D-price] | Machines themselves; Sprites product exists but docs page unverifiable (see 7) [F-sprites] | Sandboxes: 24 h max, FS + memory snapshots (memory experimental), $0.0000394/core-s [M-sandbox][M-snap][M-price] |
| 6. Cost at idle | Hibernated DO: $0 duration; $0.20/GB-mo over 5 GB [DO-pricing]; sleeping Workflow: no CPU [WF-pricing]; slept Container: $0 [CT-pricing] | Lambda $0 idle; DDB storage $0.25/GB-mo [DDB]; SFN Standard pays per transition only [SFN-price]; durable retention $0.15/GB-mo [L-pricing] | $0 between requests; memory billed while any request in flight [V-price]; Workflow retained data $0.50/GB-mo [V-WF-price] | Memory billed "each second your app is loaded"; idle window 5 s-10 min [D-price][D-runtime] | Stopped/suspended: rootfs $0.15/GB per 30 d + volumes [F-price][F-suspend] | Idle containers free after `scaledown_window` (60 s default, max 20 min) [M-cold] |
| 7. Local dev / testing | workerd + Miniflare + Vitest run tests in the real runtime; DO/WF/Queues/Containers local [Vitest][W-local] | `sam local` (Docker) for Lambda [SAM]; Step Functions Local "unsupported", no parity [SFN-local] | Workflow SDK "Local World" zero-config [V-WF-deploy]; Sandbox is remote-only (needs token) [V-SB] | Deno runtime local; Deploy-specific limits not emulated (not verified) | Docker locally; Machines API remote | No emulator: `modal serve` runs "in the cloud" [M-dev] |
| 8. Lock-in | workerd Apache-2.0, same code as prod; DOs single-process, `localDisk` experimental [workerd][workerd-capnp] | Proprietary services; ASL DSL | Workflow SDK open source with pluggable "Worlds" (Postgres, custom) [V-WF-deploy]; platform pieces proprietary | Deno runtime open; Deploy "self-hosted on your own infrastructure" claimed [D-deploy] | Plain VMs/OCI images: lowest lock-in | Python-first SDK, proprietary control plane |

## 5. Per-runtime notes

**Cloudflare.** Fit is structural: DO = session actor with SQL, alarms, hibernating WS; Workflows = durable loop; Containers/Dynamic Workers = sandboxes; WfP = Scope isolation; AI Gateway = model gateway. Recent changes to track: DO SQLite storage billing active since Jan 2026 [DO-storage]; Workflows step/storage billing since Aug 10 2026 [WF-pricing]; Containers + Sandboxes GA Apr 13 2026 [CT-GA]; Dynamic Workers open beta Mar 24 2026 [DW-beta]; DO can drive 10 Dynamic Workers concurrently (Aug 28 2026) [CF-changelog]. Caveats: 128 MB isolate; 6 concurrent outbound connections; hibernation constructor re-runs; deploy disconnects sockets.

**AWS Lambda + Step Functions + DynamoDB.** Lambda's 15 min hard cap [L-quotas] forces every loop through SFN (256 KiB state, $0.000025/transition, ASL) [SFN-quotas][SFN-price] or the new durable functions (checkpoint/replay, $8/M operations, 3,000 ops per execution, 100 MB) [L-durable][L-quotas][L-pricing]. Streaming: Function URLs only, Node, billed for full duration even after client disconnects [L-stream]; WS via API Gateway capped at 2 h / 10 min idle [APIGW-ws]. No actor primitive: session single-writer semantics must be hand-built on DynamoDB conditional writes. The credible AWS answer for agents is actually **Bedrock AgentCore Runtime** (microVM per session, 8 h, 2 vCPU/8 GB, bidirectional WS, CPU billed only when active at $0.0895/vCPU-h) [AC][AC-quotas][AC-price] plus **Lambda MicroVMs** for sandboxes [L-microvm]; both are container/VM-per-session models, not a code-first TS framework surface. Local: SAM for Lambda; Step Functions Local officially unsupported [SFN-local]. Verdict: capable, but 3-4 services and no isolate-level per-tenant story.

**Vercel Functions + Workflow.** Strongest alternative on paper. Workflows GA (Apr 16 2026): `'use workflow'`/`'use step'`, unlimited run and sleep, hooks, resumable persisted streams, open-source SDK with pluggable Worlds [V-WF][V-WF-price][V-WF-deploy][V-WF-stream]. Sandbox GA: Firecracker, 24 h sessions, persistent sandboxes [V-SB][V-SB-price]. Gaps for karmi: no per-session actor/single-writer primitive (state is event-log replay, 240 s replay cap, 2,000-event slowdown note) [V-WF-price]; WebSockets only public beta (Jun 2026) [V-ws]; per-step wall clock bounded by Function max (800 s GA / 1800 s beta) [V-limits]; memory is billed whenever a request is in flight [V-price]; every step is a fresh function invocation, so an interactive multi-turn session is many cold-ish invocations rather than one warm object. Region-pinned runs [V-WF]. No multi-tenant isolate product comparable to WfP. Verdict: good for batch/async agents; weaker for interactive Harness sessions.

**Deno Deploy.** New Deploy replaces Classic (sunset Jul 20 2026) [D-deploy]. Runtime is a long-lived app process billed on active CPU and memory-seconds, kept alive 5 s-10 min after traffic, subject to eviction mid-request [D-runtime][D-price]. No durable actor, Queues "Not supported" on the new platform, cron minute-granular [D-deploy][D-cron]. Deno Sandbox is promising (microVM <200 ms, 2 vCPU) but pre-release, 30 min max, 3-20 concurrent per region [D-SB][D-price]. Verdict: not enough primitives for v0.

**Fly Machines.** VMs with sub-second start, stop/suspend at storage-only cost ($0.15/GB rootfs per 30 d; suspend limited to <=2 GB memory, resumes in "a few hundred ms") [F-price][F-suspend][F-over]. Zero timeouts, any protocol, lowest lock-in. But no durable state/scheduling/queue primitives; a session-per-Machine model means karmi would build an orchestrator, a scheduler and a stream-resume layer itself. Sprites (agent sandboxes) exist but the docs pages fetched contained only CLI install text, so limits/pricing are unverified [F-sprites]. Verdict: excellent *sandbox/target*, poor *framework base*.

**Modal.** Python-first; functions up to 24 h [M-timeout]; Sandboxes with FS + (experimental) memory snapshots [M-sandbox][M-snap]; per-second billing, idle free after scale-down [M-price][M-cold]. HTTP endpoints capped at 150 s (redirect workaround) [M-web-timeout]; WS supported [M-web]. No local emulator ("modal serve" runs in the cloud) [M-dev]; scheduling is cron/period only [M-cron]. Verdict: strong sandbox and batch-compute provider; not a TypeScript serverless base.

## 6. Design implications for karmi

1. **Session = one SQLite-backed Durable Object per (Scope, session id).** Transcript, tool results, pending approvals and the scheduler table live in `ctx.storage.sql`. Rows <= 2 MB, so large tool outputs go to R2 with a row pointer [DO-limits].
2. **An agent-loop step must fit in 5 min CPU and should stay well under 128 MB.** Model calls are I/O and cost no CPU, but JSON parsing of large contexts does. Budget CPU per turn; configure `limits.cpu_ms` up to 300,000 [W-limits].
3. **Never rely on in-memory state across turns.** Hibernation can occur 10 s after the last event; constructor re-runs on wake [DO-lifecycle]. Rehydrate from SQL; keep the constructor cheap (`blockConcurrencyWhile` only for migrations) [DO-state].
4. **Streaming to clients is a hibernatable WebSocket owned by the session DO** (or SSE from a Worker that proxies the DO). Because outbound WebSockets never hibernate, a DO holding a *client* socket to a model provider is billed for duration; prefer HTTP streaming (fetch) for model calls, which does not block hibernation once complete [DO-ws][DO-lifecycle]. Stream resumption = client sends last-seen event id; DO replays from its SQL event table.
5. **Long or unattended loops span steps via Workflows**, with each `step.do` = one model turn or one tool call (<=1 MiB result; larger goes to R2 + pointer) [WF-limits]. Human approval = `waitForEvent` (24 h default, up to 365 d) [WF-events]. Interactive loops stay in the DO and use the alarm for "continue"/"retry" ticks (one alarm per DO; multiplex through the scheduler table like Agents SDK `schedule()`) [DO-alarms][Agents-sched].
6. **Scheduling:** DO alarm for per-session wakeups; Queues for cross-session fan-out and <=24 h delays [Q-limits]; Workflows sleep for longer horizons; cron only for fleet housekeeping [W-limits-2].
7. **Sandbox Capability has two tiers behind one interface:** `isolate` (Dynamic Workers, `globalOutbound: null`, ms start, beta) and `container` (Sandbox SDK on Containers, lite instance by default, ephemeral disk, 1-3 s cold start) [DW-beta][SB][CT-faq]. Tool results from sandboxes must be persisted to the DO because container disk is ephemeral.
8. **Scope isolation:** karmi's own code runs as one Worker keyed by Scope. If the Platform hosts tenant-authored code, it deploys to a Workers for Platforms dispatch namespace and the dispatch Worker applies per-Scope `cpuMs`/subrequest limits and an outbound Worker for egress policy [WfP-how].
9. **Model gateway:** route provider calls through AI Gateway with BYOK, per-Scope custom metadata, spend limits and fallbacks; keep the provider SDK swappable since Gateway is optional [AIG-feat].
10. **Testing:** the test surface is Vitest-in-workerd. Avoid the known hole (DO + WebSockets under per-file isolated storage) by testing the streaming layer via SSE/HTTP or with isolated storage off [Vitest-issues]. Containers tests require Docker in CI [CT-local].
11. **Deploys disconnect WebSockets** [DO-ws]: the client protocol must reconnect and resume by event id from day one.
12. **Portability boundary:** keep `Session`, `Scheduler`, `Stream`, `Sandbox`, `Gateway` as interfaces; the DO/Workflows/Containers bindings are one implementation. workerd can run it locally/self-hosted single-node, but distributed DOs are Cloudflare-only [workerd-capnp].

## 7. Open questions

- Max number of hibernatable WebSockets per DO is described only as "thousands"; no hard number found [DO-ws].
- DO maximum CPU per *alarm* invocation vs. per request (both documented as 30 s/5 min; alarm wall 15 min) needs a test.
- Whether Workflows `waitForEvent` can be driven directly from a DO binding without a Worker hop was not confirmed.
- Dynamic Workers: memory/CPU limits per dynamic Worker and GA timeline are unpublished [DW].
- Container snapshots/persistent disk: "coming soon", no date [CT-faq].
- Fly Sprites limits/pricing: both docs URLs returned only CLI install text; pricing seen only via community posts, which are not primary sources [F-sprites].
- Deno Deploy per-request CPU cap on the *new* Deploy: pricing page lists only active-CPU hours; the 10 ms/50 ms figures found are from Classic/Subhosting docs [D-price].
- Vercel WebSocket max connection duration under the beta is not published [V-ws].
- AgentCore Runtime GA status page was not fetched; quotas page is live [AC-quotas].

## 8. Sources

[W-limits]: https://developers.cloudflare.com/workers/platform/limits/
[W-limits-2]: https://developers.cloudflare.com/workers/platform/limits/ (cron triggers, workers per account)
[W-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[W-local]: https://developers.cloudflare.com/workers/local-development/
[W-ws]: https://developers.cloudflare.com/workers/runtime-apis/websockets/
[DO-overview]: https://developers.cloudflare.com/durable-objects/
[DO-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[DO-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[DO-lifecycle]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[DO-storage]: https://developers.cloudflare.com/durable-objects/api/storage-api/ and https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
[DO-state]: https://developers.cloudflare.com/durable-objects/api/state/
[DO-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[DO-alarms]: https://developers.cloudflare.com/durable-objects/api/alarms/
[DO-container]: https://developers.cloudflare.com/durable-objects/api/container/
[WF-GA]: https://developers.cloudflare.com/changelog/2025-04-07-workflows-ga/ and https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/
[WF-limits]: https://developers.cloudflare.com/workflows/reference/limits/
[WF-pricing]: https://developers.cloudflare.com/workflows/reference/pricing/
[WF-events]: https://developers.cloudflare.com/workflows/build/events-and-parameters/
[WF-sleep]: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
[WF-local]: https://developers.cloudflare.com/workflows/build/local-development/
[Q-limits]: https://developers.cloudflare.com/queues/platform/limits/
[CT-GA]: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
[CT-limits]: https://developers.cloudflare.com/containers/platform-details/limits/
[CT-pricing]: https://developers.cloudflare.com/containers/pricing/
[CT-faq]: https://developers.cloudflare.com/containers/beta-info/ (FAQ content)
[CT-local]: https://developers.cloudflare.com/containers/local-dev/
[SB]: https://developers.cloudflare.com/sandbox/ , https://developers.cloudflare.com/sandbox/get-started/ , https://developers.cloudflare.com/sandbox/platform/limits/
[DW]: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
[DW-beta]: https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
[WfP]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
[WfP-how]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/how-workers-for-platforms-works/
[WfP-pricing]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/
[WfP-limits]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/limits/
[AIG]: https://developers.cloudflare.com/ai-gateway/
[AIG-feat]: https://developers.cloudflare.com/ai-gateway/features/
[AIG-pricing]: https://developers.cloudflare.com/ai-gateway/reference/pricing/
[WAI]: https://developers.cloudflare.com/workers-ai/
[KV]: https://developers.cloudflare.com/kv/concepts/how-kv-works/
[D1]: https://developers.cloudflare.com/d1/platform/limits/
[Vec]: https://developers.cloudflare.com/vectorize/platform/limits/
[Agents]: https://developers.cloudflare.com/agents/
[Agents-gh]: https://github.com/cloudflare/agents
[Agents-sched]: https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
[Vitest]: https://developers.cloudflare.com/workers/testing/vitest-integration/
[Vitest-issues]: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
[Miniflare]: https://developers.cloudflare.com/workers/testing/miniflare/
[workerd]: https://github.com/cloudflare/workerd
[workerd-capnp]: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
[CF-changelog]: https://developers.cloudflare.com/changelog/
[L-quotas]: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
[L-pricing]: https://aws.amazon.com/lambda/pricing/
[L-stream]: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
[L-durable]: https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html
[L-microvm]: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
[SFN-quotas]: https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html
[SFN-price]: https://aws.amazon.com/step-functions/pricing/
[SFN-local]: https://docs.aws.amazon.com/step-functions/latest/dg/sfn-local.html
[SAM]: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-local.html
[DDB]: https://aws.amazon.com/dynamodb/pricing/on-demand/
[APIGW-ws]: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
[AC]: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
[AC-quotas]: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html and https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html
[AC-price]: https://aws.amazon.com/bedrock/agentcore/pricing/
[V-limits]: https://vercel.com/docs/functions/limitations
[V-fluid]: https://vercel.com/docs/fluid-compute
[V-price]: https://vercel.com/docs/functions/usage-and-pricing
[V-ws]: https://vercel.com/changelog/websocket-support-is-now-in-public-beta
[V-WF]: https://vercel.com/docs/workflows and https://vercel.com/docs/workflows/concepts
[V-WF-price]: https://vercel.com/docs/workflows/pricing
[V-WF-deploy]: https://workflow-sdk.dev/docs/deploying
[V-WF-stream]: https://workflow-sdk.dev/docs/foundations/streaming
[V-Q-price]: https://vercel.com/docs/queues/pricing
[V-SB]: https://vercel.com/docs/sandbox
[V-SB-price]: https://vercel.com/docs/sandbox/pricing
[D-deploy]: https://docs.deno.com/deploy/
[D-runtime]: https://docs.deno.com/deploy/reference/runtime/
[D-price]: https://deno.com/deploy/pricing and https://docs.deno.com/deploy/manual/pricing-and-limits/
[D-cron]: https://docs.deno.com/deploy/reference/cron/
[D-SB]: https://docs.deno.com/sandbox/
[F-over]: https://fly.io/docs/machines/overview/
[F-price]: https://fly.io/docs/about/pricing/
[F-suspend]: https://fly.io/docs/reference/suspend-resume/
[F-autostop]: https://fly.io/docs/launch/autostop-autostart/
[F-sprites]: https://fly.io/sprites (CLI install text only; limits/pricing unverified)
[M-timeout]: https://modal.com/docs/guide/timeouts
[M-web]: https://modal.com/docs/guide/webhooks
[M-web-timeout]: https://modal.com/docs/guide/webhook-timeouts
[M-sandbox]: https://modal.com/docs/guide/sandbox
[M-snap]: https://modal.com/docs/guide/sandbox-snapshots
[M-price]: https://modal.com/pricing
[M-cold]: https://modal.com/docs/guide/cold-start
[M-cron]: https://modal.com/docs/guide/cron
[M-dq]: https://modal.com/docs/guide/dicts-and-queues
[M-dev]: https://modal.com/docs/guide/developing-debugging
