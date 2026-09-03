# Outbound fetch routing: AI Gateway or Outbound Worker for MCP and provider traffic

Research note with a live check, 2026-09-03, answering GitHub issue #37 (child of map #1). Primary sources only: developers.cloudflare.com read from the `cloudflare/cloudflare-docs` repository (`production`, commit `a9454f3`, 2026-09-03; sparse clone in `/tmp`), the `cloudflare/workerd` repository (`main`, `src/workerd/server/workerd.capnp` and `src/workerd/io/compatibility-date.capnp`), the published `@modelcontextprotocol/client` 2.0.0 tarball (`dist/index.mjs`, `dist/index.d.mts`), and the live Cloudflare account (throwaway Worker, `wrangler` 4.128.0, `compatibility_date = 2026-08-04`, `global_fetch_strictly_public` on; deleted afterwards; no account identifiers appear here). Every claim carries a bracket key from §7; anything not verifiable from a primary source or the live check is marked UNVERIFIED. Prior notes are cited as [MC] (mcp-consumption), [PS] (provider-seam), [CR] (cost-reporting), [SG] (provider-stream-gateway-spike) and [SE] (sandbox-egress / -spike).

## 1. Result

**Neither AI Gateway nor an Outbound Worker is the egress seam for karmi. The seam is the `fetch` function karmi already injects: one per-Scope `fetch` wrapper, built by the Harness at turn start and handed to `StreamableHTTPClientTransport({ fetch })` and to the provider adapters. It sees every request (proven live: POST, the auto-opened GET SSE stream, SSE-bodied POST responses, DELETE, from a Worker and from a Durable Object), it can deny by hostname before any bytes leave, and it does not touch streaming because it returns the upstream `Response` untouched. AI Gateway stays where #4/#18 put it — optional provider-route config for model calls, with `cf-aig-metadata` attribution — and is not used for MCP. Outbound Workers are ruled out on primary-source grounds alone: Cloudflare documents that they "do not intercept fetch requests made from Durable Objects", and every karmi provider and MCP call originates in a Thread DO.**

| Question (#37) | Finding | Source |
|---|---|---|
| Can AI Gateway's universal endpoint proxy an arbitrary MCP server? | **No.** The Universal Endpoint is deprecated and takes a JSON array of `{ provider, endpoint, authorization, query }` where `provider` must be a supported provider; it is a fan-out over provider routes, not a URL proxy. | [AIG-universal] |
| Is there any "any URL" passthrough? | **Yes, but not for this.** *Custom Providers* (beta) map an account-level `custom-{slug}` to an HTTPS `base_url`; `gateway/.../custom-{slug}/{path}` is forwarded to `{base_url}/{path}` with "full control over the upstream path" and the native body. Creating one is a control-plane call (`AI Gateway - Edit` token, per account, not per Scope). Nothing in the page mentions GET, `text/event-stream`, or header echo; every example is an OpenAI-shaped POST. Whether a legacy MCP session (`Mcp-Session-Id` on a POST reply, GET SSE stream) survives it is **UNVERIFIED — could not be live-checked** (§4). | [AIG-custom] |
| Does AI Gateway have an MCP feature? | Only as a *server*: the "MCP server" page links to `mcp-server-cloudflare/apps/ai-gateway`, an MCP server that exposes AI Gateway's own logs/config to agents. The docs index has no MCP-client or MCP-proxy page. Cloudflare's product for fronting arbitrary MCP servers is Zero Trust **MCP Server Portals**, not AI Gateway [MC §5]. | [AIG-mcp-server][MC] |
| Does an Outbound Worker see `fetch` from DOs? | **No.** "Outbound Workers do not intercept fetch requests made from Durable Objects or mTLS certificate bindings." They intercept the user Worker's `fetch()`; enabling one also disables `connect()` in user Workers. Coverage of WebSocket upgrades and service bindings is not documented (UNVERIFIED). Requires Workers for Platforms, which is deferred and not enabled on the account (#12) — not live-checked. | [WfP-outbound][WfP-arch] |
| What can an Outbound Worker stamp/deny? | Everything a `fetch` handler can: it receives the request, reads `env.<param>` values passed on `dispatcher.get(name, {}, { outbound: { … } })` (e.g. a tenant name), and may rewrite headers, add auth, log, or refuse. | [WfP-outbound] |
| Dynamic Worker equivalent | Worker Loader `globalOutbound: ServiceStub \| null` — `null` cuts off `fetch()` and `connect()`; a `ctx.exports` loopback binding with `props` gives a per-sandbox interceptor. karmi's isolate tier already uses `null` (#9). Closed beta on Cloudflare. In workerd it is the Worker-level `globalOutbound @6 :ServiceDesignator = "internet"` field. | [W-loader][workerd-capnp] |
| Does `global_fetch_strictly_public` interact with either path? | **No.** The flag only changes how global `fetch()` to a hostname *in the Worker's own zone* is routed (front door instead of origin, to close an SSRF hole). It says nothing about interception; the open-source runtime only declares the flag (`globalFetchStrictlyPublic @51`, used nowhere but the flag table and its test), so the behaviour is edge-side. Live: with the flag on, a Worker `fetch` to its own `workers.dev` URL looped back through the front door and reached its own handler (§4). An Outbound Worker would see that loopback request like any other `fetch`; AI Gateway is a different hostname and is unaffected. | [W-flag][workerd-flag][live] |
| Does a custom `fetch` in `StreamableHTTPClientTransport` see everything? | **Yes.** `opts.fetch` is used for the POST (`send`), the GET stream (`_startOrAuthSse`, opened automatically after `notifications/initialized` on a legacy server), the DELETE (`terminateSession`) and — via `createFetchWithInit(opts.fetch, opts.requestInit)` — every OAuth discovery/token request (`fetchFn: this._fetchWithInit`). The SDK also exports a `Middleware = (next: FetchLike) => FetchLike` composition API. | [MCP-http-src][MCP-types][live] |

## 2. What AI Gateway can and cannot do for karmi

AI Gateway is a per-provider reverse proxy with an account-scoped token: "Any token with `AI Gateway Run` can send requests through every gateway in the account", and the docs' own advice for tenant isolation is "separate Cloudflare accounts or a Worker-side AI Gateway binding rather than relying on token scope" [AIG-auth]. So it cannot be a per-Scope *control* point by itself; per-Scope control has to be expressed in what the Worker sends. What it does give:

- **Attribution**: `cf-aig-metadata` (≤ 5 string/number/boolean entries, `cf.` reserved) is stored on the log and searchable [AIG-metadata]; the join key is the `cf-aig-log-id` response header [CR §2]. Already decided in #18: stamp `scope/agent/thread/turn`.
- **Per-key quotas**: Dynamic Routing has *Rate Limit* and *Budget Limit* nodes keyed on a request field such as `metadata.user_id`, so a `metadata.scope` key would give per-Scope request/cost quotas at the gateway [AIG-dyn][AIG-dyn-json] — but routes are invoked as `model: "dynamic/{route}"` on the OpenAI-compatible `/compat` endpoint [AIG-dyn-usage], not on the native Anthropic route karmi's direct adapter uses [PS §2.2]. Not for v0; Scope budgets are the Platform's through `UsageHandler` (#18).
- **Streaming**: proven for the native Anthropic route in [SG] (not re-checked here — it needs an `AI Gateway Run` token, see §4). Request timeouts are measured to the first byte, so streams are safe from `cf-aig-request-timeout` [AIG-request]. Guardrails do not support `stream: true` [AIG-guard].
- **Custom Providers** would let a `base_url` point at an MCP server and would log every tool call body (10 MB per log) into the gateway [AIG-custom][AIG-limits]. Even if SSE and session headers passed (UNVERIFIED), it is the wrong shape: one account-level provider row per registered server, created with an Edit token from a control-plane call at registration time, all Scopes sharing it, and MCP payloads (which carry user data and tool results, not prompts) retained in gateway logs by default. Nothing per-Scope is gained that the `fetch` wrapper does not already give.

## 3. What an Outbound Worker can and cannot do for karmi

The Outbound Worker is exactly the mechanism the question imagines — a `fetch` handler "between your customer's Workers and the public Internet" that can "create, allow, or block lists for hostnames" and "configure authentication to your APIs behind the scenes", parameterised per dispatch call [WfP-outbound]. Three facts settle it for karmi:

1. **It does not see Durable Object traffic** [WfP-outbound]. karmi's Turn loop, provider stream and MCP calls run inside the Thread DO (#3, #6, #10); the front Worker only routes. An Outbound Worker would see nothing that matters.
2. **It governs tenant-authored Workers**, i.e. code uploaded into a dispatch namespace. karmi v0 is one Worker with name-based isolation (ADR 0001); there is no user Worker to intercept. Under a future WfP deployment the Platform's own tenant code would be covered, which is what ADR 0001 already says.
3. **It is unavailable** on the account (WfP deferred, #12), so it could not be live-checked; the two facts above are from the docs.

The same runtime idea *is* available to karmi where it matters: Worker Loader `globalOutbound` for isolate scripts (already `null`), and the Containers `interceptOutboundHttp/Https` hook for the container tier (already decided in #26/#33/#34 as a Worker-side hostname allow-list; not re-decided here) [W-loader][SE].

## 4. Live check

Throwaway Worker `karmi-egress-spike` (`@modelcontextprotocol/client` 2.0.0, `wrangler` 4.128.0, `compatibility_date = 2026-08-04`, `compatibility_flags = ["global_fetch_strictly_public"]`, one SQLite DO `Probe`). It hosted (a) a 50-line **legacy-era** (`protocolVersion: "2025-06-18"`) Streamable HTTP MCP server at `/mcp` that mints `Mcp-Session-Id` on `initialize`, returns `tools/list` as an SSE-bodied POST response (notification first, result 300 ms later), serves a GET SSE stream of three `notifications/message` ticks 700 ms apart, and accepts DELETE; and (b) a `/client` (Worker) and `/client-do` (DO RPC) route running `new Client()` + `StreamableHTTPClientTransport(url, { fetch: scopedFetch(scope, allow), requestInit: { redirect: "manual" } })` with default `versionNegotiation: 'legacy'`, then `connect()`, `listTools()`, `callTool("echo")`, a 3 s wait, `terminateSession()`. `scopedFetch` records `{ method, url, accept, mcp-session-id }` per request, returns `403 egress denied` for hostnames outside `allow`, otherwise sets `x-karmi-scope` and calls global `fetch`. Deleted with `wrangler delete` afterwards.

**Check 2 — per-Scope `fetch` wrapper (required): passes, from Worker and from DO.** Requests seen by the wrapper, in order, identical in both shapes:

| # | Method | Accept sent | `Mcp-Session-Id` sent | Status | Response `Content-Type` | Note |
|---|---|---|---|---|---|---|
| 1 | POST | `application/json, text/event-stream` | — | 200 | `application/json` | `initialize`; server minted the session id, transport captured it |
| 2 | POST | same | yes | 202 | — | `notifications/initialized` |
| 3 | GET | `text/event-stream` | yes | 200 | `text/event-stream` | opened by the transport itself right after #2; three ticks delivered at 799/1508/2214 ms |
| 4 | POST | same | yes | 200 | `text/event-stream` | `tools/list`; SSE-bodied reply parsed, `["echo"]` returned, in-stream notification delivered at 94 ms |
| 5 | POST | same | yes | 200 | `application/json` | `tools/call` → `echo:hi` |
| 6 | GET | `text/event-stream` | yes | 200 | `text/event-stream` | automatic reconnect after the first stream closed |
| 7 | DELETE | — | yes | 200 | — | `terminateSession()` |

Denial: with `allow=example.com` the very first POST was refused inside the wrapper (`SdkHttpError: Error POSTing to endpoint: egress denied`), no upstream request was made, and the client surfaced a clean error. Streaming: SSE bodies passed through the wrapper unchanged (it returns the `Response` it got); both the POST-SSE and GET-SSE paths delivered every event with the timing above. Session: the `Mcp-Session-Id` echoed on every request after `initialize`, from the DO exactly as from the Worker. Self-loopback: the Worker fetched its own `workers.dev` URL with `global_fetch_strictly_public` on and reached its own `/mcp` handler — the flag routes own-hostname `fetch` through the front door as documented (the flag-off case was not run).

Against a public server (`https://mcp.deepwiki.com/mcp`, from the Worker): `initialize` answered over SSE with `protocolVersion: "2025-11-25"` and **no** `Mcp-Session-Id` (stateless server), `tools/list` returned three tools, the automatic GET was issued but had produced neither headers nor an error after 3 s (a direct `curl -H 'accept: text/event-stream'` likewise had no response headers after 5 s — the server holds the stream open silently). The wrapper saw all four requests. `redirect: "manual"` caused no issue on either server.

**Check 1 — AI Gateway fronting an MCP server: could not be run.** The wrangler OAuth session in this workspace carries `ai (write)` but the AI Gateway REST API rejects it (`10000 Authentication error` on `GET …/ai-gateway/gateways` and `…/custom-providers`), and no API token with `AI Gateway Run`/`Edit` was available; creating a Custom Provider needs `Edit`, and the development gateway is authenticated (needs `Run`) [SG]. Nothing was purchased or enabled. The check is small and worth running when a token exists: create `custom-mcpspike` with `base_url = https://<spike-worker>.workers.dev`, then drive the same `/client?target=https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-mcpspike/mcp` and read the `seen[]` table — the three things to look for are the `Mcp-Session-Id` response header on #1, `text/event-stream` on #3/#4, and whether the GET returns at all.

**Check 3 — Worker → AI Gateway Anthropic streaming**: not re-run, same token gap; [SG] already proved the native Anthropic route streams and forwards `anthropic-beta`.

## 5. Recommendation (v0)

**Which traffic goes where.**

| Traffic | Route | Control | Attribution |
|---|---|---|---|
| Provider calls (Anthropic direct adapter, AI SDK adapter) | Direct to the provider, or via AI Gateway when `ProviderConfig.gateway.kind = "cloudflare"` — unchanged from #4 | Host set derived from `ProviderConfig` (`baseURL` or the gateway URL); the same `fetch` wrapper enforces it | `cf-aig-metadata { scope, agent, thread, turn }` on the gateway path (#18); `usage.recorded` on every path |
| MCP (Streamable HTTP, both eras, OAuth discovery and token calls) | Direct to the server through `StreamableHTTPClientTransport({ fetch: scopedFetch })` | Host set derived from the Scope's registered servers plus the authorization-server origins discovered for them; SSRF check (`isBlockedUrl`, vendored per [MC]) on every URL; `redirect: "manual"`; `403` from the wrapper for anything else | Nothing is stamped outbound (a Scope id sent to a third-party server would leak the isolation key of ADR 0001); attribution is the Thread event log (`tool.call`/`tool.result` already carry server, tool, duration) |
| Container-tier scripts | Containers outbound hook, `setAllowedHosts()` | #26/#33/#34, unchanged | unchanged |
| Isolate-tier scripts | `globalOutbound: null` | #9, unchanged | — |
| Outbound Worker | not used | — | — |

**The mechanism.** One internal function, `scopedFetch(policy): typeof fetch`, built once per Turn from the resolved Scope config and passed everywhere karmi makes an outbound request: `StreamableHTTPClientTransport({ fetch })`, `new Anthropic({ fetch })`, and the AI SDK provider `fetch` option (all three accept it [MCP-types][PS §2.1]). It (1) parses the URL, (2) rejects blocked/private addresses, (3) rejects hostnames outside the policy's host set with a synthetic `403` carrying a karmi error body, (4) adds the gateway headers when the target is the configured gateway, and (5) returns the upstream `Response` as-is, so streams, `Mcp-Session-Id`, `cf-aig-log-id` and every other header reach the caller untouched. It keeps no state and writes no events; a denied request is a Tool error the model sees (`isError`) or a provider error the Step records, like any other failure. A Logger line per denial is enough observability for v0.

**`ScopeConfig` egress fields.** The wrapper's host set is *derived* (registered MCP servers, discovered authorization servers, the provider/gateway base URL), so the only configuration that earns its place is a ceiling on what may be registered:

```ts
// Deployment defaults ≤ Scope, merged as an intersection like every other ceiling (ADR 0001).
egress?: {
  mcpHosts?: string[];   // hostnames or "*." globs an MCP server (and its authorization server) may live on;
                         // absent = any public host. Checked at server registration and again by scopedFetch.
};
```

No `allow` list for providers (the provider is chosen by `ProviderConfig`, which is already Scope config), no `deny` list, no gateway toggle for MCP, no per-request analytics switch. `GatewayConfig.metadata` (#4) remains the way a Platform adds its one custom key beside karmi's four [CR §8].

**Why not more.** AI Gateway would add a control-plane dependency per registered MCP server, an account-wide Edit token in the registration path, gateway-side retention of tool payloads, and an unverified transport, in exchange for analytics the Thread event log already has. An Outbound Worker would add Workers for Platforms and still not see the DO traffic that is all of karmi's traffic. The `fetch` wrapper is the smallest model in which "which hosts can this Scope reach" and "what left the building" are unsurprising.

## 6. What this changes on the map

- **#6 (MCP consumption), open question 6** — answered: `fetch` injection is the egress seam and carries SSE and sessions intact; AI Gateway/Outbound Worker are not used for MCP. §4 recommendation 4 stands as written (`fetch`, `requestInit: { redirect: "manual" }`).
- **#4 (provider seam)** — no change to `GatewayConfig`/`ProviderConfig`; add that every adapter must accept karmi's `fetch` (all candidates do) and that the gateway is reached *through* the wrapper, not around it.
- **#18 (observability)** — no change; the note confirms gateway analytics are provider-only and per-account, and that per-Scope quotas at the gateway would require the `/compat` Dynamic Routing path, which the direct Anthropic adapter does not use. MCP call analytics stay on the event log.
- **#21 (MCP registry contract)** — "no proxying" is now also a platform fact: the only Cloudflare proxy that could sit between a DO and an MCP server is unavailable to DO traffic. The registry snapshot additionally carries the discovered authorization-server origins so `scopedFetch` can admit the token endpoint.
- **#10 / ADR 0001** — sharpen the last decision bullet: Outbound Workers govern tenant-authored Workers only and do not intercept Durable Object `fetch`, so they can never police karmi's own provider/MCP egress even under Workers for Platforms; that egress is policed in-process by `scopedFetch`. Add `egress.mcpHosts` to the ScopeConfig field list.
- **ADR 0002** — unchanged. `global_fetch_strictly_public` remains recommended; it neither helps nor hinders either routing option, and the live loopback shows the documented front-door behaviour.
- **#26/#33/#34** — untouched, as instructed.

## 7. Not verified

1. Whether AI Gateway Custom Providers forward `GET`, stream `text/event-stream` bodies, and echo `Mcp-Session-Id` — no `AI Gateway Edit`/`Run` token was available; exact reproduction steps are in §4.
2. Whether an Outbound Worker intercepts WebSocket upgrades or service-binding calls from a user Worker — not documented; WfP not enabled.
3. The flag-off behaviour of a Worker fetching its own `workers.dev` hostname — only the flag-on case was run.
4. Whether `cf-aig-metadata` can drive Dynamic Routing quotas on the native Anthropic route — the docs show `dynamic/{route}` only on `/compat`.
5. Anthropic streaming through the gateway was not re-run here (token gap); relies on [SG].

## 8. References

Cloudflare docs (`cloudflare/cloudflare-docs` `production` @ a9454f3, 2026-09-03; paths under `src/content/docs`)
[AIG-universal]: https://developers.cloudflare.com/ai-gateway/usage/universal/ (`ai-gateway/usage/universal.mdx`: deprecated; payload array of `provider/endpoint/authorization/query`)
[AIG-custom]: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/ (`ai-gateway/configuration/custom-providers.mdx`: beta; `base_url` HTTPS; `custom-{slug}/{path}` → `{base_url}/{path}`; `AI Gateway - Edit` token; "Impact of deletion")
[AIG-mcp-server]: https://developers.cloudflare.com/ai-gateway/mcp-server/ (`ai-gateway/mcp-server.mdx`: external link to `mcp-server-cloudflare/apps/ai-gateway`; the only file under `ai-gateway/` matching `mcp`)
[AIG-auth]: https://developers.cloudflare.com/ai-gateway/configuration/authentication/ (`cf-aig-authorization`; "AI Gateway API tokens are account-scoped")
[AIG-metadata]: https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/ (five entries; `cf.` reserved; `cf.user_id` behind Access)
[AIG-dyn]: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/ (Rate Limit / Budget Limit nodes "per your key, per period")
[AIG-dyn-json]: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/ (`type: "rate"`, `key: "metadata.user_id"`, `limitType: count|cost`)
[AIG-dyn-usage]: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/ (`model: "dynamic/<route>"` on `/compat/chat/completions`)
[AIG-request]: https://developers.cloudflare.com/ai-gateway/configuration/request-handling/ (timeout "based on when the first part of the response comes back")
[AIG-guard]: https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/ ("Guardrails does not support streaming")
[AIG-limits]: https://developers.cloudflare.com/ai-gateway/reference/limits/ (10 MB per log; 5 metadata entries)
[WfP-outbound]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/ (`outbound: { service, parameters }`; `dispatcher.get(name, {}, { outbound })`; `connect()` disabled; "do not intercept fetch requests made from Durable Objects or mTLS certificate bindings")
[WfP-arch]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/ (outbound Worker in the request flow)
[W-loader]: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/ (`globalOutbound: ServiceStub | null`; `ctx.exports` loopback with `props`; closed beta)
[W-flag]: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public (`src/content/compatibility-flags/global-fetch-strictly-public.md`)

workerd (`cloudflare/workerd` `main`)
[workerd-capnp]: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp (`Worker.globalOutbound @6 :ServiceDesignator = "internet"`)
[workerd-flag]: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp (`globalFetchStrictlyPublic @51`, enable/disable flag names and rationale; GitHub code search finds no other use in the repo besides `compatibility-date-test.c++`)

MCP TypeScript SDK (`@modelcontextprotocol/client` 2.0.0, npm tarball)
[MCP-types]: `dist/index.d.mts` — `StreamableHTTPClientTransportOptions { authProvider?, requestInit?, fetch?: FetchLike, reconnectionOptions?, sessionId?, protocolVersion?, … }`; `type Middleware = (next: FetchLike) => FetchLike`; exports `createFetchWithInit`, `applyMiddlewares`, `withOAuth`, `withLogging`
[MCP-http-src]: `dist/index.mjs`, `StreamableHTTPClientTransport` — constructor `this._fetch = opts?.fetch; this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit)`; GET in `_startOrAuthSse` via `(this._fetch ?? fetch)(this._url, { method: "GET", … })`; POST in `send` via `(this._fetch ?? fetch)(this._url, init)`, session captured from the `mcp-session-id` header on the handshake reply; `_startOrAuthSse` scheduled when `isInitializedNotification(message)`; auth calls pass `fetchFn: this._fetchWithInit`

Live check
[live]: §4 of this note (throwaway Worker, deleted)

Prior karmi notes and decisions
[MC]: docs/research/mcp-consumption.md (§4 SSRF guard and `fetch` injection; §5 AI Gateway has no MCP feature, MCP Server Portals; §9 Q6)
[PS]: docs/research/provider-seam.md (§2.1 every `create*`/SDK accepts `fetch`; §2.2 gateway facts; §4 `GatewayConfig`)
[CR]: docs/research/cost-reporting.md (§2 `cf-aig-log-id`, metadata join; §8 stamping rule)
[SG]: docs/research/provider-stream-gateway-spike.md (native Anthropic route streams and forwards `anthropic-beta`)
[SE]: docs/research/sandbox-egress.md and docs/research/sandbox-egress-spike.md (container-tier allow-list, not re-decided)
ADR 0001: docs/adr/0001-scope-name-based-isolation.md; ADR 0002: docs/adr/0002-compatibility-baseline.md; map decisions #4, #6, #9, #10, #12, #18, #21, #26 in https://github.com/dsblabs/karmi/issues/1
