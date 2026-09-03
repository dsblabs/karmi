# Sandbox egress live checks: pip trust, DO-side await, 443 without interception

Spike note, 2026-09-03, for the ticket "Spike: sandbox egress live checks — pip trust, DO-side await, 443 without interception" (#34, child of map #1). It closes the three required items and six of the optional ones from `sandbox-egress.md` §7, and fixes the final wording of the container-tier resolution (#26) §1, §2 and §6.

Everything below was observed on the live Cloudflare account with a throwaway Worker: `@cloudflare/sandbox` 0.12.9 (`@cloudflare/containers` 0.3.7), `wrangler` 4.128.0, `compatibility_date = 2026-08-04`, image `FROM docker.io/cloudflare/sandbox:0.12.9-python`, `instance_type = "lite"`, containers placed in `ord06`. Two Sandbox subclasses were deployed: `SbIntercept` (`enableInternet = false`, `interceptHttps = true`) and `SbNoIntercept` (same, `interceptHttps = false`); a third plain DO (`ThreadStub`) stood in for karmi's Thread DO. The allow-list was applied per instance with `setAllowedHosts()` before the first `exec`, as #26 §6 prescribes. The Worker and all instances were deleted afterwards; no account identifiers appear here.

## 1. Results

| §7 item | Verdict |
|---|---|
| 1. pip trust | **Passes.** `python3 -m pip install --no-cache-dir tabulate polars` with `allowedHosts = ["pypi.org", "files.pythonhosted.org"]` downloads a 58.6 MB wheel from `files.pythonhosted.org` and installs, with no `PIP_CERT` and no pip configuration. `npm install` (`registry.npmjs.org`), `git clone https://github.com/…` (`github.com`) and `curl` (45 MB from `pypi.org/simple/`) pass on their hosts alike. The injected CA is on the system bundle and in `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, exactly as the research note said. |
| 2. Denied-host UX | Every denied request, HTTP or HTTPS, gets `HTTP/1.1 520 Server Error` with the body `Origin is disallowed` (20 bytes). Exact tool prints in §2 below. |
| 3. DO-side await | **Does not hold.** A DO awaiting `waitForExit()` (a process-log SSE stream) survives 60–90 s runs but on a silent process the stream dies deterministically at **258–259 s** with `Network connection lost.` — reproduced twice (31-minute and 20-minute runs), in both shapes (Sandbox-DO-internal await, Thread-DO-driven await via the stub), both DOs failing in the same second. The container and its process table survived (PID 1 age 2471 s afterwards, process `completed`, exit 0). §3 below. |
| 4. Long streams / `Expect: 100-continue` | A 340-byte, 345-second chunked response (`httpbin.org/drip`) streamed through the proxy intact. A 2 MB `curl --data-binary` POST, which sends `Expect: 100-continue`, completed in 6.1 s (4.9 s with `-H 'Expect:'`); the documented stall did not occur on 0.12.9. |
| 5. 443 without `interceptHttps` | **Confirmed mandatory, and worse than expected.** With `interceptHttps = false`, `enableInternet = false`, `allowedHosts = ["pypi.org"]`: `curl https://pypi.org/` hangs until curl's connect timeout (`Failed to connect to pypi.org port 443 after 134968 ms: Connection timed out`), while `http://pypi.org/` on port 80 still gets its `301`. Nothing intercepts 443, so packets are dropped rather than refused. |
| 6. WebSocket / HTTP/2 | `curl --http2` to `pypi.org` and `httpbin.org` negotiates **HTTP/1.1** through the proxy. WebSocket not exercised. |
| 7. `sleepAfter` during a silent exec | With `sleepAfter = "10s"`, a 25 s `sleep` with no output completed (`survived`); the same instance then ran a 376 s exec. An in-flight `exec` renews the activity timer as the research note inferred. |
| 8. Subrequest accounting | Not measured. |
| 9. `wrangler dev` TPROXY | Not exercised. |

Two things outside the list were also observed and matter for karmi:

- **The default `cloudflare/sandbox` image has no Python.** `python3` and pip live only in the `-python` tag (`cloudflare/sandbox:0.12.9-python`, python-build-standalone 3.11.14, pip 25.3, not on `PATH` as `pip` — use `python3 -m pip`). Node in the image is v22, not the Dockerfile's `NODE_VERSION=24` default. `@karmi/sandbox-container` must build `FROM …-python`.
- **A container started under `interceptHttps = true` with no allow-list ever applied is broken.** If `setAllowedHosts()` was never called on the instance, the first `exec` longer than ~4 s fails with `HTTP error! status: 500` from the container at 4.4 s and the platform restarts the container (PID 1 age 1 s on the next call). Applying `setAllowedHosts([])` — an *empty* list — makes the same instance work. karmi always applies the list before the first exec, so `KarmiSandbox` must do it unconditionally, including for a `[]` grant; `karmi doctor` cannot catch this, so it is a code invariant, not a config check.

Other platform facts confirmed on the way: the container resolves DNS through Cloudflare's resolvers (`nameserver 2606:4700:4700::1111`, `2620:fe::fe`; `pypi.org` resolves to `fd00::119:1`, a private IPv6 the proxy owns); ports other than 80/443 (8443, 8080, 53) are dropped silently (connect hangs, no refusal); `*.pythonhosted.org` matches as a glob; `max_instances` is a hard admission limit — `ContainerUnavailableError: Maximum number of running container instances exceeded` — reached in this spike only because `sleepAfter` kept finished instances alive, which is the `maxContainers` ceiling's job in karmi.

## 2. What tools print on a 520

Captured on `SbIntercept`; karmi's `run_script` stderr explainer should recognise these.

**pip, wheel host denied** (`pypi.org` allowed, `files.pythonhosted.org` not), exit 1:

```
Collecting tqdm
ERROR: Could not install packages due to an OSError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Max retries exceeded with url: /packages/…/tqdm-4.70.0-py3-none-any.whl.metadata (Caused by ResponseError('too many 520 error responses'))
```

**pip, index host denied** (empty allow-list), exit 1 — the 520 is *hidden* at default verbosity, so the explainer must not rely on seeing it:

```
ERROR: Could not find a version that satisfies the requirement tqdm (from versions: none)
ERROR: No matching distribution found for tqdm
```

(`-vv` shows `https://pypi.org:443 "GET /simple/tqdm/ HTTP/1.1" 520 20`.)

**npm** (`registry.npmjs.org` denied, fresh cache):

```
npm error code E520
npm error 520 Server Error - GET https://registry.npmjs.org/is-odd
```

Note npm serves from `~/.npm/_cacache` when it can — a package installed once while allowed installs again after the host is denied, without any network. Within one Workspace that is fine; it just means "denied" cannot be inferred from "install succeeded".

**git**, exit 128:

```
remote: Origin is disallowed
fatal: unable to access 'https://github.com/octocat/Hello-World.git/': The requested URL returned error: 520
```

**curl**, exit 0 (it is a valid HTTP response):

```
HTTP/1.1 520 Server Error
Content-Type: text/plain;charset=UTF-8

Origin is disallowed
```

Explainer rule for karmi: a stderr containing `520` together with `Origin is disallowed`, `E520`, `too many 520 error responses`, or pip's `from versions: none` on a Workspace whose grant does not cover the host → append one line naming the host and `capabilities.scripts.egress.allow`. Match on the hostname in the message where present; for pip's silent case, name the index host.

## 3. DO-side await, in detail

Three shapes were run, all with `setKeepAlive(true)` held for the duration and the allow-list applied:

| Shape | 60–90 s | 31 min |
|---|---|---|
| A. Sandbox DO method: `this.startProcess()` then `proc.waitForExit()` inside one RPC call from the Thread DO's alarm, then `env.THREAD.getByName(t).record(...)` | completes, calls the Thread DO | `Network connection lost.` at 258.9 s; the catch ran once (a `ps` exec still worked, PID 1 age 258 s) and then the context vanished — the 10 s poll loop that followed never wrote a line |
| B. Thread DO alarm drives the stub: `sandbox.startProcess()` then `proc.waitForExit()` (an RPC callback that runs the SSE loop inside the Sandbox DO) | completes | `Network connection lost.` at 258.1 s, same second as A; `getProcessLogs` afterwards returned `HTTP error! status: 500`; the Thread DO alarm itself survived and recorded the failure |
| C. Sandbox DO method holding a plain `setTimeout` loop and polling `getProcess()` every 5 s (no stream) | 40 s completes | not run for 31 min |
| D. Shape B with a *chatty* process (`echo tick` every 15 s) | — | **10 min completes**, exit 0, all 40 ticks in the logs |

A and B failed at 258–259 s on every run (31-minute and 20-minute attempts, four DOs in total), always with the two DOs failing in the same second; D, differing only in that the process wrote output, ran 10 minutes without incident; and the 345 s outbound-proxy stream in §1 carried a byte per second. Together: **a process-log stream that carries no bytes for ~4 m 18 s is closed** (`Network connection lost.` on the DO side) — an idle timeout somewhere between the container port and the DO, which the SDK does not paper over with heartbeats. When the stream dies inside a Sandbox DO method, that method's context goes with it (shape A's fallback poll loop never ran); the caller sees the rejection (shape B).

So the stream is fine for `job.progress` and often for completion, but it is not a durable hold: any silent stretch over four minutes drops it, and DOs are in any case reset by every deploy (`reset because its code was updated` kills an in-flight await with no error delivered to it — this spike's first 31-minute attempt was lost exactly that way) while the container and its process table carry on.

What *is* durable: the container (PID 1 outlived the DO reset by 37 minutes under `setKeepAlive(true)`), the process table (`listProcesses()` still reported the finished process with its exit code), and DO storage + alarms (the Thread DO's alarm handler completed and recorded).

## 4. Final wording for #26

**§1, add** (unchanged from the research note's proposal, now confirmed):

> `limits.idleMs` maps to the Sandbox `sleepAfter` option, whose timer counts SDK activity only; an in-flight `exec` renews it, a background process does not. While a Job is running the adapter holds the container with `setKeepAlive(true)` and clears it (or destroys the container) when the Job ends; `jobMaxWallMs` remains the hard cap.

**§2, replace** "Completion re-enters as `job.completed { result, artifacts }` by the container runner calling back into the Thread's DO by name" **with:**

> Completion is **observed, not reported**: the Sandbox adapter persists `{ jobId, processId, startedAt }` in the Thread DO at promotion and the Thread DO's watchdog alarm polls `getProcess(processId)` (default every 10 s; status `completed`/`failed`/`killed` ends the Job, then `/out` is exported and `job.completed` is enqueued). The process-log stream is used only for `job.progress` chunks and is treated as best-effort: a dropped stream re-attaches on the next alarm tick, never fails the Job. No container-side callback: nothing runs in the container that the Script could forge, and there is no durable in-flight hold to build on — a process-log stream with no output for ~4 m 18 s is closed with `Network connection lost.` (observed on every silent 20/31-minute run; a process printing every 15 s held for 10 min), and a DO context awaiting the container is reset by every deploy without an error being delivered to it. `getProcess` returning `null` or the container failing to answer is `job.failed { reason: "container_lost" }` as in §3.

**§6, replace** the enforcement sentence with:

> Enforced Worker-side by karmi's `Sandbox` subclass on the Containers outbound hook: `enableInternet = false`, `interceptHttps = true`, and the Thread's `allow` list applied per instance with `setAllowedHosts()` **unconditionally before the first `exec`, including `[]`** (a container that starts under interception without any list applied fails its first long exec with a 500 and restarts). Only ports 80 and 443 exist for a script; other ports are dropped at connect time (the connect hangs to the client's timeout, it is not refused), and DNS resolves only through Cloudflare's resolvers. A denied HTTP(S) request receives an HTTP `520 Origin is disallowed` response from the proxy, not a connect failure; karmi's `run_script` result explains 520s in stderr as an egress denial naming the host and the grant key (tool prints in the spike note). Requires `export { ContainerProxy }` from the Worker entrypoint (`create-karmi` template; `karmi doctor` checks it). `allow` entries are hostnames or `*` globs; the default grant example is `["pypi.org", "files.pythonhosted.org"]` because pip fetches wheels from the second host. `interceptHttps = false` is not a degraded mode: HTTPS to an allowed host then hangs to a connect timeout, so the flag is mandatory.

**§5 image line:** `@karmi/sandbox-container` builds `FROM docker.io/cloudflare/sandbox:<ver>-python` — the un-suffixed image has no Python. Say "Sandbox SDK Python image (Ubuntu 22.04)".

No change to the isolate tier, the `Job` seam or the `container_lost` rule.

## 5. Method

One Worker, four routes: `/exec` (apply allow-list, `sandbox.exec`), `/await-do` (set a Thread DO alarm that either calls a Sandbox DO method holding `waitForExit`, or drives the stub itself), `/probe` and `/hold` (Worker-side and DO-side polling variants), `/procs`, `/destroy`. Every measurement is quoted from the JSON these returned or from the Thread DO's event log; `wrangler tail` supplied the container-side `500` and the `max_instances` errors. The spike source is not kept: it is 200 lines of throwaway glue and the shapes above are enough to reproduce it.
