# Sandbox egress: does a Worker-side hostname allow-list exist, and does it survive pip/npm/streams?

Research note, 2026-09-03, answering GitHub issue #33 (child of map #1; checks §1–2 and §6 of the #26 container-tier resolution). Primary sources only: `cloudflare/containers` (`main`, commit `a17055c`, 2026-08-23; npm `@cloudflare/containers` 0.3.7, published 2026-06-04, whose `dist/lib/container.js` carries the same allow/deny/intercept logic as `main`), `cloudflare/sandbox-sdk` (`main`, commit `20f9da4`, 2026-08-27 = the `@cloudflare/sandbox` 0.12.9 release commit; 0.12.9 is `latest`, `0.13.0-next.751.1` is `@next`), the `cloudflare/cloudflare-docs` repository (`production`, commit `5acee0d`, 2026-09-02; Containers and Sandbox pages plus the 2026 changelog), `cloudflare/workerd` `src/workerd/io/container.capnp` and `src/workerd/api/container.h` (`main`, capnp last changed in commit `c90c954`, 2026-08-06), and `@cloudflare/workers-types` 5.20260903.1. Where docs and source disagree the source wins and the disagreement is called out. Every external claim carries a bracket key from section 8; standing karmi decisions are cited as [CONTEXT], [ADR-2] and the issue resolutions [I9], [I13], [I26].

## 1. Recommendation

**The assumption in #26 §6 holds in substance: the Containers platform has a Worker-side egress hook, `@cloudflare/sandbox` inherits it unchanged from `@cloudflare/containers`, and it is a per-HTTP-request hostname gate (Host header for HTTP, TLS SNI for HTTPS) that pip, npm, git-over-HTTPS and curl pass through once the sandbox's ephemeral CA is trusted — which the Sandbox runtime does automatically. Three details in §6 are wrong and §1–2 need one addition each; none changes the shape of the decision.**

| #33 question | Verdict | Source |
|---|---|---|
| Does a Worker-side hook exist? | **Yes.** `ctx.container.interceptOutboundHttp(addr, fetcher)`, `interceptOutboundHttps(addr, fetcher)`, `interceptAllOutboundHttp(fetcher)` in the runtime; `@cloudflare/containers` wraps them as `enableInternet`, `allowedHosts`, `deniedHosts`, static `outbound` / `outboundByHost` / `outboundHandlers` and the runtime `setAllowedHosts()`, `setOutboundByHost()`, `setOutboundHandler()` family. `Sandbox extends Container`, so all of it is on the Sandbox DO. | [WT][WD-h][CT-src][SB-src][SB-outbound] |
| Per-connection or per-request? | **Per HTTP request.** The runtime terminates TCP (and, with HTTPS interception, TLS) in a sidecar and hands each decrypted HTTP request to a `WorkerEntrypoint.fetch(request)` (`ContainerProxy`). Which connections are diverted is chosen per connection by the `hostPort` filter, but policy runs per request. Policy changes apply to in-flight connections without dropping them. | [WD-capnp][CT-src][CT-outbound] |
| Hostnames or IPs? | **Hostnames.** HTTP: `Host`; HTTPS: "hostname glob matched against the TLS SNI hostname". IPs and CIDRs are also accepted by the runtime filter. Inside `ContainerProxy` the JS matcher is a plain `*` glob on `url.hostname`; the docs' CIDR example in `deniedHosts` is not honoured by that JS matcher (it would only match the literal string). karmi uses hostnames only. | [WD-capnp][CT-src][SB-outbound] |
| `pip install` / `npm install` / long streams? | **Yes for HTTPS clients that use the system trust store or the standard CA env vars.** The Sandbox runtime appends the injected CA to the system bundle and sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO` in the process that spawns every session shell. Streams pass through the handler's `fetch(request)` untouched; no duration limit is documented (experiment §7). Known wrinkle: `Expect: 100-continue` uploads stall the proxy. | [SB-cert][SB-session][SB-src][CT-outbound] |
| Fallback if it failed? | Not needed. The only container-side alternative (proxy env vars) is bypassable by the script and is strictly worse (§4). | — |
| `sleepAfter` / idle | **Confirmed, with a catch:** the timer only counts SDK traffic (HTTP proxy calls or the RPC session being busy), never container processes. A promoted Job is a background process, so the adapter must hold the container alive for the Job's duration (§5). | [CT-src][SB-src][SB-options] |
| Container → DO by name | **Exists as a pattern, not a primitive:** an `outboundByHost` virtual hostname whose handler runs in the Worker with `env`, so `env.THREAD.getByName(name)` works. Per-instance routing data goes in via `setOutboundByHost(host, method, params)` (persisted in DO storage). The container process must be wrapped to make the call; the message is forgeable by the script and must be treated as untrusted (§6). | [SB-wc][CL-outbound][CT-src] |

### Smallest change to #26

**§6, replace the enforcement sentence with:**

> Enforced Worker-side by karmi's `Sandbox` subclass on the Containers outbound hook: `enableInternet = false`, `interceptHttps = true`, and the Thread's `allow` list applied per instance with `setAllowedHosts()` before the first `exec` (the list always also contains karmi's internal callback host). Only ports 80 and 443 exist for a script; other ports are refused by the platform at connect time, and DNS resolves only through Cloudflare's resolvers. A denied HTTP(S) request receives an HTTP `520 Origin is disallowed` response from the proxy, not a connect failure; karmi's `run_script` result explains 520s in stderr as an egress denial naming the host and the grant key. Requires `export { ContainerProxy }` from the Worker entrypoint (`create-karmi` template; `karmi doctor` checks it). `allow` entries are hostnames or `*` globs; the default grant example is `["pypi.org", "files.pythonhosted.org"]` because pip fetches wheels from the second host.

**§1, add:** `limits.idleMs` maps to the Sandbox `sleepAfter` option, whose timer counts SDK activity only. While a Job is running the adapter holds the container with `setKeepAlive(true)` and clears it (or destroys the container) when the Job ends; `jobMaxWallMs` remains the hard cap.

**§2, add:** completion re-enters through an `outboundByHost` virtual host (`karmi.internal`) bound per instance to `{ thread, jobId }` with `setOutboundByHost()`; the handler treats the body as untrusted, keys the event on `ctx.containerId`, and resolves the Thread DO by name. The alternative — the adapter DO awaiting the process and calling the Thread itself — needs a live experiment (§7) and would remove the callback entirely; adopt it later if it works.

**§5 nit:** the Sandbox base image is Ubuntu 22.04 with Bun, Node and python-build-standalone 3.11, not Debian slim [SB-docker]. Say "Sandbox SDK base image" and drop "Debian slim".

Nothing in the isolate tier [I9] or the `Job` seam [I13] changes.

## 2. What the Containers platform offers for egress today

| Layer | Mechanism | Granularity | Sees | Notes | Source |
|---|---|---|---|---|---|
| Runtime start option | `enableInternet` (`false` by default in the capnp; `@cloudflare/containers` defaults it to `true`) | Per container start; "takes effect when the container starts" | — | With `false`: "Only ports 80, 443, and DNS are available, and DNS queries use Cloudflare's DNS servers." Non-HTTP ports are "denied". | [WD-capnp][CT-src][CT-outbound] |
| Runtime interception | `interceptOutboundHttp(hostPort, fetcher)` → capnp `setEgressHttp`; `hostPort` = `<ip|cidr|hostnameGlob>[:port]`, default port 80 | Connection diverted by filter; each HTTP request delivered to `fetcher.fetch()` | Host header hostname | "Can be called before or after starting the container, and even while connections are open. In-flight TCP connections pick up the new handler automatically." | [WD-capnp][CT-outbound][WT] |
| Runtime interception, TLS | `interceptOutboundHttps(hostPort, fetcher)` → `setEgressHttps`; default port 443 | Same | **TLS SNI hostname** | Runtime "must ensure the container trusts the interception CA"; an ephemeral per-instance CA appears at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`; "the ephemeral private key never leaves the container runtime sidecar". Requires runtime ≥ 2026-04-02 (karmi floor is 2026-08-04 [ADR-2]). | [WD-capnp][CL-tls][CT-src] |
| Runtime interception, all | `interceptAllOutboundHttp(fetcher)` | All port-80 traffic | Host | Used by the library whenever allow/deny lists or a catch-all handler exist. | [CT-src][WT] |
| Runtime interception, raw TCP | `interceptOutboundTcp` → `setEgressTcp` (ip/cidr only, "no application-layer hostname") | Per connection | IP only | **Experimental** (`workerd_experimental` flag); not in workers-types. Not usable for hostname policy. | [WD-h][WD-capnp] |
| Library policy | `allowedHosts`, `deniedHosts` (class fields or `setAllowedHosts`/`setDeniedHosts`/`allowHost`/`denyHost`), `outbound`, `outboundByHost`, `outboundHandlers` + `setOutboundHandler`/`setOutboundByHost` with `params` | Per request in `ContainerProxy.fetch` | `url.hostname`, `*` glob, trailing dot stripped | Precedence: deniedHosts → allowedHosts → per-host handler → catch-all handler → `fetch(request)` if allowed/`enableInternet` → `520 Origin is disallowed`. Configuration is persisted in DO KV and re-applied before every container start. | [CT-src][CT-outbound] |
| Static egress IPs | none documented | — | — | The FAQ's only egress entry points to the outbound-traffic guide. | [CT-faq] |
| Hard runtime cap | capnp `hardTimeoutMs` exists; the library never sets it; "Cloudflare does not stop a container instance after a fixed maximum runtime" but "does not guarantee that any container instance will run for any set period of time" | — | — | Host restarts can evict a container at any time → `container_lost` stays a real case [I26 §3]. | [WD-capnp][CT-faq] |

Runtime-level facts that matter for karmi's wording: denial of an HTTP(S) request is an HTTP response (`520`, body `Origin is disallowed`) produced by `ContainerProxy`; only non-80/443 ports fail at the socket. `git@github.com:` (SSH), database ports and SMTP are therefore always unreachable in the container tier, regardless of `allow`.

## 3. What `@cloudflare/sandbox` adds on top

`@cloudflare/sandbox` 0.12.9 (`latest`, 2026-08-27) depends on `@cloudflare/containers ^0.3.5` and `capnweb`; the 1.0 preview is `0.13.0-next.*` on `@next` [SB-npm][SB-pkg]. Relevant surface, source-verified at `20f9da4`:

| Item | Finding | Source |
|---|---|---|
| Class relationship | `export class Sandbox extends Container`; every outbound field/method above is inherited and callable on the `getSandbox()` stub over RPC. `getSandbox(ns, id, { sleepAfter, keepAlive, containerTimeouts, normalizeId, transport, labels })`; there is no `network`/`egress` option on `getSandbox` — policy is class fields plus the `set*` methods. | [SB-src][SB-options] |
| `interceptHttps` default | **Docs say** "Sandboxes intercept HTTPS traffic by default — `interceptHttps` is set to `true` on the Sandbox class". **Source (main and the 0.12.9 tarball) does not set it**; the only reference is `if (this.interceptHttps) this.envVars.SANDBOX_INTERCEPT_HTTPS = '1'`, so it inherits `false` from `Container`. karmi must set `interceptHttps = true` explicitly. | [SB-outbound][SB-src][SB-dist][CT-src] |
| CA trust in the image | When `SANDBOX_INTERCEPT_HTTPS=1`, the container server waits up to 5 s for the CA file, exits if absent, appends it to the first system bundle found (`/etc/ssl/certs/ca-certificates.crt` on Ubuntu), and sets `NODE_EXTRA_CA_CERTS=<ca>` plus `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO=<bundle>` in its own `process.env`. Session shells are spawned with `{ ...process.env, ...options.env }`, so `exec`/`startProcess` children inherit them. Changelog: added in PR #550. | [SB-cert][SB-server][SB-session][SB-changelog] |
| SDK-internal use of the same hook | R2 "egress mounts" and the S3 credential proxy are built on `setOutboundByHost('r2.internal' / 's3-credential-proxy.internal', …)` + `interceptOutboundHttp`, and the SDK ships its own `ContainerProxy` subclass that dispatches those two hosts before deferring to the base. A comment there records that the class-name-keyed handler registries are "NOT shared between the Durable Object's execution context and the ContainerProxy WorkerEntrypoint context" — runtime-registered handlers are invisible to the proxy; handlers must be assigned at module top level, and per-instance data must travel as `params`. | [SB-src] |
| Proxy stall | s3fs is configured to omit `Expect: 100-continue` because it "prevent[s] the outbound proxy from stalling waiting for a 100 response". | [SB-src] |
| Transport | RPC (capnweb over one WebSocket) is the recommended default; HTTP/WebSocket transports are deprecated. RPC multiplexes all calls in one subrequest. | [CL-deprec][SB-limits] |
| Base image | `ubuntu:22.04` runtime with `ca-certificates curl wget procps git unzip zip jq`, Bun, `node:<ver>-slim` binaries, python-build-standalone 3.11.14; Alpine-based cloudflared stage. | [SB-docker] |
| 1.0 preview direction | `exec(argv)` returns a process handle (`waitForExit()`, `logs()`, `output()`, `kill()`); `startProcess`, default sessions, `exposePort`, desktop and buffered APIs are deprecated or removed. Sandbox ID outlives the container; "Same sandbox ID does not mean the same container." | [SB-10-proc][SB-10-life][CL-deprec] |
| Export requirement | "Export `ContainerProxy` from your Worker entrypoint for outbound interception to work"; the library throws if `ctx.exports.ContainerProxy` is missing. | [SB-outbound][CT-src] |
| Local dev | `wrangler dev` runs a TPROXY sidecar in the sandbox's network namespace "mirroring production behavior" (needs Docker). | [SB-outbound] |

## 4. Fallback options compared, with the pip/npm/SSE analysis

| Option | Where enforced | Bypassable by the script? | pip / npm / git | SSE and long streams | Verdict |
|---|---|---|---|---|---|
| **A. Platform hook** (`enableInternet=false` + `interceptHttps=true` + per-instance `setAllowedHosts`) | Worker (`ContainerProxy`) | No — traffic is diverted below the container's network namespace | pip: `pypi.org` + `files.pythonhosted.org` over HTTPS; trust via system bundle / `SSL_CERT_FILE`. npm: `registry.npmjs.org`; trust via `NODE_EXTRA_CA_CERTS`. git: HTTPS only (`GIT_SSL_CAINFO`); SSH impossible. | Response bodies are streamed by `fetch(request)`; in-flight connections survive policy edits. No documented cap. `Expect: 100-continue` stalls (send `-H 'Expect:'`). WebSocket upgrade and HTTP/2 through the proxy undocumented. | **Adopt.** This is the #26 assumption, verified. |
| B. Catch-all `outboundHandlers.egress` with `params: { allow }` instead of `setAllowedHosts` | Worker | No | Same as A | Same as A | Same enforcement; buys a karmi-authored denial body (e.g. JSON naming host and grant key) instead of `520 Origin is disallowed`, and a place to emit a Thread event per denied host. Worth it only if the 520-explainer in the Tool result proves insufficient. |
| C. Container-side proxy env vars (`HTTP_PROXY`/`HTTPS_PROXY`, `pip.conf`, `.npmrc`) pointing at a local filtering proxy | Inside container | **Yes** — `unset HTTPS_PROXY`, `--proxy ""`, raw sockets | Works for well-behaved clients only | Works for well-behaved clients only | Reject: violates "not inside the container" [I26 §6] and needs a proxy process in the image. There is no Worker-hosted proxy endpoint a container could target; the platform's own hook is the proxy. |
| D. `enableInternet=false` with no allow list | Platform | No | Nothing installs | — | Already the default (`allow: []`). |
| E. `interceptOutboundTcp` for non-HTTP ports | Runtime, IP-only | No | Would enable `git+ssh`, databases | — | Experimental flag only, IP filters only; not for v0. |
| F. `deniedHosts` on top of `enableInternet=true` | Worker | No | Everything except the deny list | — | Inverse of the grant model; reject. |

pip specifics: pip resolves `https://pypi.org/simple/` and then downloads from `https://files.pythonhosted.org/`, so a grant of `["*.pypi.org"]` (the example in #26) would let the index load and every wheel download fail with 520. pip ≥ 24.2 consults the system trust store on Python ≥ 3.10; older pips use certifi and need `PIP_CERT`/`--cert` — whether the Sandbox image's pip honours the injected CA out of the box is item 1 in §7. npm reads `NODE_EXTRA_CA_CERTS` from the Node process environment, which the Sandbox runtime sets. git over HTTPS reads `GIT_SSL_CAINFO`. Python `requests` reads `REQUESTS_CA_BUNDLE`; `httpx`/`urllib` read `SSL_CERT_FILE`.

## 5. `sleepAfter` and idle semantics as implemented

| Aspect | Implementation | Source |
|---|---|---|
| Default | `DEFAULT_SLEEP_AFTER = '10m'` in `Container`; Sandbox also `'10m'`; `getSandbox(..., { sleepAfter })` calls `setSleepAfter` on the DO (persisted in DO storage). | [CT-src][SB-src][SB-options] |
| What counts as activity | `renewActivityTimeout()` sets `sleepAfterMs = now + sleepAfter`. It is called on every `containerFetch`, on RPC `onActivity`, and when `inflightRequests` returns to 0. `isActivityExpired()` returns `false` while `inflightRequests > 0`; the RPC transport increments it on busy→idle transitions of the whole capnweb session (a returned stream still being drained keeps it busy). **A background process started with `startProcess` does not count.** | [CT-src][SB-src] |
| What happens at expiry | The DO alarm loop calls `onActivityExpired()` → default `stop()` → `container.signal(SIGTERM)` to the container's root process (the Sandbox server), then the platform "waits up to 15 minutes for that process to exit" before SIGKILL. `Sandbox.onActivityExpired` skips this when `keepAlive` is on. | [CT-src][SB-src][CT-arch] |
| `keepAlive` | Persisted flag; "heartbeat pings every 30 seconds"; must be turned off or the sandbox destroyed explicitly. | [SB-options][SB-src] |
| `destroy()` | `container.destroy()` = SIGKILL; triggers `onStop`. `stop(signal)` sends any signal. | [CT-src] |
| Disk | "All disk is ephemeral … the next time it is started, it will have a fresh disk." Idle stop, replace (deploy, failure, host restart) and destroy all lose processes, terminals and files; the sandbox ID and DO identity persist. | [CT-arch][SB-10-life] |
| Runtime-side inactivity | capnp `setInactivityTimeout` exists ("must not shutdown the container" while a connection is open) but neither library calls it; the library alarm is the only idle policy. | [WD-capnp][CT-src] |

Mapping to #26: `idleMs` → `sleepAfter` per sandbox (Scope ceiling checked by karmi before the call). Turn-end destruction → `destroy()`; cancel → `killProcess(id, 'SIGTERM')`, 5 s, `killProcess(id, 'SIGKILL')` at process level, then `destroy()`. The one correction: during a promoted Job the adapter must keep the container alive on purpose (`setKeepAlive(true)` for the Job window, reset at `job.completed`/`failed`/`cancelled`), because idle is measured on SDK traffic, and a 30-minute `pip install && python job.py` with no output would otherwise be SIGTERMed at `idleMs`. Holding the process log stream open is an alternative that also counts as in-flight, but it ties liveness to a stream the adapter must never drop; `keepAlive` is the explicit contract.

## 6. Container → Durable Object callback by name

What exists: an `outboundByHost` handler is Worker code with the full `env`, so it can address any DO namespace by name (`env.THREAD.getByName(thread)`); `ctx.containerId` identifies the calling sandbox's DO id; `setOutboundByHost(host, method, params)` binds per-instance `params` that are persisted and passed through `ContainerProxy` props. The docs show exactly this for DO state ("Access Durable Object state") [SB-wc][CL-outbound]. There is no other container→Worker path: `tcpPort.fetch` is Worker→container only, and the RPC `localMain` control callback is internal to the SDK (tunnel exits) [SB-src].

What karmi must build:

1. `KarmiSandbox extends Sandbox` with `enableInternet = false`, `interceptHttps = true`, and module-level `KarmiSandbox.outboundHandlers = { jobCallback }` (registries are keyed by class name and populated at module evaluation; `wrangler` must not rename the class).
2. On Job promotion: `setOutboundByHost('karmi.internal', 'jobCallback', { thread, jobId })` and `allowHost('karmi.internal')` (allow-list gating precedes handlers).
3. A wrapper around the script: `bash -c '<script>; rc=$?; tar /out …; curl -sS -X POST http://karmi.internal/jobs/$JOB/done -d "{rc:$rc}"'` — plain HTTP is fine ("for traffic that stays within the Cloudflare Developer Platform, plain HTTP is secure").
4. The handler validates `ctx.containerId` against `params`, ignores duplicates, uploads `/out` (or has the container upload through an `outboundByHost` R2 host), then calls the Thread DO by name to enqueue `job.completed`.
5. Treat the callback as untrusted: the script runs in the same process tree and can post it itself; the worst case is an early `job.completed` for its own job, which the wrapper's real completion must not double-post.

Alternative to test (§7 item 3): the adapter DO calls `startProcess` and then awaits the process (log stream, or `waitForExit()` on `@next`), and on exit calls the Thread DO itself — no container-side wrapper, no forgeable message, and the in-flight stream doubles as the keep-alive. Blocker to verify: whether a DO may hold an RPC stream open for `jobMaxWallMs` (30 min) without the platform reclaiming it.

## 7. Open items needing a live experiment

1. **pip trust:** with `interceptHttps = true` on the stock Sandbox image, does `pip install pandas` succeed against `allowedHosts = ["pypi.org", "files.pythonhosted.org"]` without `PIP_CERT`? (Depends on the bundled pip version and python-build-standalone's OpenSSL honouring `SSL_CERT_FILE`.) Same check for `npm install`, `git clone https://…`, `curl`.
2. **Denied-host UX:** confirm the exact stderr pip/npm print on a 520 from the proxy, so the Tool-result explainer matches.
3. **DO-side await:** can `KarmiSandbox` hold a `streamProcessLogs`/`waitForExit` for 30 minutes inside a DO and still be the one to call the Thread? If yes, drop the container-side callback from §2.
4. **Long-lived downstream streams:** an SSE or chunked response held open for >5 min through `fetch(request)` in the outbound handler; and an upload >1 MB with curl's automatic `Expect: 100-continue`.
5. **HTTPS on port 443 without `interceptHttps`** under `enableInternet = false` + `allowedHosts`: expected to be refused (nothing intercepts 443), which is why `interceptHttps = true` is mandatory — confirm.
6. **WebSocket and HTTP/2 through the proxy** (only matters if a script streams from an API that requires them).
7. **`sleepAfter` during a sync `exec`** over RPC: confirm a 25 s command with no output never trips a short `idleMs` (the busy-poll should renew it).
8. **Subrequest accounting** for handler `fetch(request)` calls during a large `npm install` (hundreds of tarballs) — docs are silent.
9. **`wrangler dev` interception** on the CI Docker job (TPROXY sidecar) so the live smoke test also covers denial.

## 8. Sources

[CT-src]: https://github.com/cloudflare/containers/blob/main/src/lib/container.ts (`main`, commit `a17055c`, 2026-08-23) — `ContainerProxy.fetch` precedence, `allowedHosts`/`deniedHosts`, `interceptHttps` default `false`, `applyOutboundInterception`, `persistOutboundConfiguration`, `startContainerIfNotRunning` (re-applies interception before `start`), `renewActivityTimeout`, `isActivityExpired`, `onActivityExpired`, `DEFAULT_SLEEP_AFTER = '10m'`, `simpleGlobMatch`
[CT-npm]: `npm view @cloudflare/containers` — 0.3.7 published 2026-06-04; `dist/lib/container.js` inspected from the tarball
[CT-outbound]: https://developers.cloudflare.com/containers/guides/outbound-traffic/ (`src/content/docs/containers/guides/outbound-traffic.mdx` at `5acee0d`) — block/allow, HTTPS + CA trust, non-HTTP traffic, precedence, low-level API
[CT-arch]: https://developers.cloudflare.com/containers/concepts/architecture/ (last updated 2026-08-28) — SIGTERM/15 min/SIGKILL, ephemeral disk
[CT-faq]: https://developers.cloudflare.com/containers/faq/ — no fixed max runtime, no guarantee, egress pointer
[CT-limits]: https://developers.cloudflare.com/containers/platform/limits/
[CT-class]: https://developers.cloudflare.com/containers/reference/container-class/ — `sleepAfter`, `onActivityExpired`, `renewActivityTimeout`
[CL-outbound]: https://developers.cloudflare.com/changelog/2026-03-26-outbound-workers/ — outbound Workers, `ctx.containerId` → DO pattern; requires containers ≥ 0.2.0 / sandbox ≥ 0.8.0
[CL-tls]: https://developers.cloudflare.com/changelog/2026-04-13-sandbox-outbound-workers-tls-auth/ — TLS interception, per-instance ephemeral CA, allow/deny lists, dynamic handlers; containers 0.3.0 / sandbox 0.8.9
[CL-deprec]: https://developers.cloudflare.com/changelog/2026-06-09-deprecating-sandbox-sdk-features/ — RPC transport default, deprecations, 1.0 preview
[SB-src]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/src/sandbox.ts (`main`, commit `20f9da4`, 2026-08-27; 0.12.9) — `SANDBOX_INTERCEPT_HTTPS`, `sleepAfter`/`keepAlive` persistence, RPC busy/idle → `inflightRequests`, `onActivityExpired` override, R2/S3 egress mounts via `setOutboundByHost` + `interceptOutboundHttp`, registry-not-shared comment, s3fs `Expect:` note, `localMain` control callback
[SB-dist]: `npm pack @cloudflare/sandbox@0.12.9` — `dist/sandbox-*.js` contains only the `if (this.interceptHttps)` env-var reference; `@cloudflare/containers` is an unbundled dependency
[SB-cert]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox-container/src/cert.ts — `trustRuntimeCert()`
[SB-server]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox-container/src/server.ts — calls `trustRuntimeCert()` when `SANDBOX_INTERCEPT_HTTPS === '1'`
[SB-session]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox-container/src/session.ts — `Bun.spawn({ env: { ...process.env, ...options.env } })`
[SB-docker]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/Dockerfile — `ubuntu:22.04` runtime, Bun, `node:*-slim`, python-build-standalone 3.11.14
[SB-changelog]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/CHANGELOG.md — PR #550 (`interceptHttps` auto-trust), 0.12.7–0.12.9 entries
[SB-npm]: `npm view @cloudflare/sandbox` — 0.12.9 (2026-08-27, `latest`), `0.13.0-next.751.1` (`next`)
[SB-pkg]: https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/package.json — deps `@cloudflare/containers ^0.3.5`, `capnweb`, `hono`
[SB-outbound]: https://developers.cloudflare.com/sandbox/guides/outbound-traffic/ (`.mdx` at `5acee0d`) — claims `interceptHttps` defaults to `true` on Sandbox (contradicted by source), `ContainerProxy` export, runtime policy methods, local-dev TPROXY
[SB-wc]: https://developers.cloudflare.com/sandbox/guides/workers-connections/ — bindings and DO access from `outboundByHost`
[SB-options]: https://developers.cloudflare.com/sandbox/configuration/sandbox-options/ — `sleepAfter`, `keepAlive`, `containerTimeouts`, `normalizeId`
[SB-bg]: https://developers.cloudflare.com/sandbox/guides/background-processes/ — `startProcess`, `keepAlive` for long-running work
[SB-limits]: https://developers.cloudflare.com/sandbox/platform/limits/ — subrequest limits, RPC transport
[SB-10-life]: https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/ — sandbox ID vs container, idle stop/replace/destroy table
[SB-10-proc]: https://developers.cloudflare.com/sandbox/1-0-preview/processes/ — `exec(argv)` process handle, `waitForExit()`
[WD-capnp]: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/container.capnp (last change commit `c90c954`, 2026-08-06) — `enableInternet`, `hardTimeoutMs`, `listenTcp`/`IpFilter`, `setInactivityTimeout`, `setEgressHttp`, `setEgressHttps` (SNI glob, CA trust), `setEgressTcp`
[WD-h]: https://github.com/cloudflare/workerd/blob/main/src/workerd/api/container.h — `interceptOutboundHttp/Https/All`, `interceptOutboundTcp` behind `workerd_experimental`
[WT]: `@cloudflare/workers-types` 5.20260903.1 `index.d.ts` — `interface Container { interceptOutboundHttp; interceptAllOutboundHttp; interceptOutboundHttps; setInactivityTimeout; exec; … }`
[CONTEXT]: `CONTEXT.md` — Script, Workspace, Job
[ADR-2]: `docs/adr/0002-compatibility-baseline.md` — compatibility date floor 2026-08-04
[I9]: https://github.com/dsblabs/karmi/issues/9 — isolate tier
[I13]: https://github.com/dsblabs/karmi/issues/13 — `Job` seam
[I26]: https://github.com/dsblabs/karmi/issues/26 — container-tier resolution under review
[I33]: https://github.com/dsblabs/karmi/issues/33 — this question
