# 1. Scope isolation is name-based, not binding-based

Date: 2026-08-29. Status: accepted. Decided in [Scope model: how tenancy threads through every primitive](https://github.com/dsblabs/karmi/issues/10).

## Context

Every Primitive, secret and config in karmi resolves under a Scope, and nothing in one Scope may see another. On Cloudflare there are two ways to draw that line: give each Scope its own resources (R2 bucket, DO namespace, dispatch-namespace Worker via Workers for Platforms), or share one set of bindings and derive every storage identity from the Scope id. Scopes are created by the Platform at runtime and may number in the tens of thousands, so provisioning per Scope would make the Cloudflare API part of karmi's hot path.

## Decision

- `ScopeId` is an opaque string minted by the Platform (`[A-Za-z0-9_-]{1,64}`); the Framework never parses, generates or enumerates it.
- All Durable Object names are `{scope}/{kind}/{id}` via `idFromName`; all R2 keys are prefixed `{scope}/`. One internal `keys` module mints them and is reachable only through the `karmi.scope(id)` handle — user code never constructs a storage name.
- Per-Scope state (provider/gateway config, Capability ceilings, policy defaults, versioned Agent Specs, MCP registry, Thread and User indexes) lives in one SQLite `ScopeConfig` DO per Scope. No D1 in v0.
- Deployment-wide defaults come from code; Scope config overrides field-by-field, ceilings merge as a minimum.
- Workers for Platforms isolates, per-Scope limits and Outbound Workers are a Platform-layer addition for tenant-authored code; the Framework does not require them. Outbound Workers never intercept Durable Object `fetch`, so even under Workers for Platforms they cannot police karmi's own provider/MCP egress; that is enforced in-process by a per-Scope `fetch` wrapper (`scopedFetch`) whose host set is derived from Scope config, with `egress.mcpHosts` as the only egress field (a registration ceiling, merged as an intersection). Decided in [Outbound fetch routing](https://github.com/dsblabs/karmi/issues/37).

## Consequences

- Isolation is as strong as the secrecy of the ScopeId plus the discipline that only the `scope()` handle builds names. A bug in `keys` is a cross-tenant bug; it gets tests of its own.
- Deleting a Scope is a walk (`scope.destroy()`: indexes → `deleteAll()` per DO → R2 prefix → tombstone), not a bucket drop; late alarms and queued jobs must check the tombstone.
- Data residency per Scope (DO jurisdictions) is not a v0 feature; adding it later means a `jurisdiction` field in ScopeConfig applied at name-minting time, which the single `keys` module makes tractable.
- A second runtime needs to reimplement only the `keys` module and the ScopeConfig store.
