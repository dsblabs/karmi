import { describe, expect, it } from "vitest";
import { KarmiError, parseScopeConfig, resolveScopeConfig, scopeConfigJsonSchema, type ScopeConfigDocument } from "../src/index.js";

describe("resolveScopeConfig", () => {
  const deployment: ScopeConfigDocument = {
    providers: { default: { adapter: "anthropic" }, cheap: { adapter: "openai" } },
    ceilings: {
      scripts: { tier: "container", limits: { cpuMs: 5_000, wallMs: 60_000 } },
      longRunning: { maxSteps: 200 },
      scheduling: { maxPending: 50, cron: true },
      providerTools: { tools: ["web_search", "web_fetch"] },
      approvals: { timeout: 86_400_000 },
    },
    policy: [{ match: { annotations: { destructiveHint: true } }, effect: "ask" }],
  };

  it("returns the Deployment defaults for an empty Scope document", () => {
    expect(resolveScopeConfig(deployment, {})).toEqual(deployment);
  });

  it("merges numeric ceilings as the minimum of the two", () => {
    const resolved = resolveScopeConfig(deployment, { ceilings: { scripts: { limits: { cpuMs: 9_000, wallMs: 10_000 } }, longRunning: { maxSteps: 500, maxTokens: 1_000 } } });
    expect(resolved.ceilings?.scripts).toEqual({ tier: "container", limits: { cpuMs: 5_000, wallMs: 10_000 } });
    expect(resolved.ceilings?.longRunning).toEqual({ maxSteps: 200, maxTokens: 1_000 });
  });

  it("lets a Scope only tighten the tier, cron and Provider Tool lists", () => {
    const resolved = resolveScopeConfig(deployment, { ceilings: { scripts: { tier: "isolate" }, scheduling: { cron: false }, providerTools: { tools: ["web_search", "web_fetch"] } } });
    expect(resolved.ceilings?.scripts).toMatchObject({ tier: "isolate" });
    expect(resolved.ceilings?.scheduling).toEqual({ maxPending: 50, cron: false });
    expect(resolveScopeConfig({ ceilings: { providerTools: { tools: ["web_search"] } } }, { ceilings: { providerTools: { tools: ["web_fetch"] } } }).ceilings?.providerTools).toEqual({ tools: [] });
  });

  it("lets either side switch a Capability off", () => {
    expect(resolveScopeConfig(deployment, { ceilings: { scripts: false } }).ceilings?.scripts).toBe(false);
    expect(resolveScopeConfig({ ceilings: { delegation: false } }, { ceilings: { delegation: { maxDepth: 3 } } }).ceilings?.delegation).toBe(false);
  });

  it("caps the Approval timeout", () => {
    expect(resolveScopeConfig(deployment, { ceilings: { approvals: { timeout: 60_000 } } }).ceilings?.approvals).toEqual({ timeout: 60_000 });
  });

  it("puts Scope policy rules before Deployment rules", () => {
    const scopeRule = { match: { tool: "weather" }, effect: "allow" as const };
    expect(resolveScopeConfig(deployment, { policy: [scopeRule] }).policy).toEqual([scopeRule, deployment.policy![0]]);
  });

  it("overrides Provider profiles by name and keeps the rest", () => {
    const resolved = resolveScopeConfig(deployment, { providers: { default: { adapter: "openai", models: ["openai/*", "anthropic/*"] } } });
    expect(resolved.providers).toEqual({ default: { adapter: "openai", models: ["openai/*", "anthropic/*"] }, cheap: { adapter: "openai" } });
  });
});

describe("parseScopeConfig", () => {
  it("rejects unknown keys with a JSON pointer", () => {
    expect(() => parseScopeConfig({ providers: { default: { adapter: "anthropic", region: "eu" } } })).toThrowError(/invalid at "\/providers\/default"/);
  });

  it("refuses secret values, pointing at the credential store", () => {
    expect(() => parseScopeConfig({ providers: { default: { adapter: "anthropic", apiKey: "sk-ant-123" } } })).toThrowError(/scope\.credentials\.put/);
    expect(() => parseScopeConfig({ providers: { default: { adapter: "anthropic", credential: "sk-ant-123" } } })).toThrowError(/scope:<name> or deployment:<name>/);
  });

  it("accepts credential references", () => {
    expect(parseScopeConfig({ providers: { default: { adapter: "anthropic", credential: "scope:anthropic" } } }).providers?.default?.credential).toBe("scope:anthropic");
  });

  it("accepts a full Provider profile: gateway, compaction, media, providerOptions and headers", () => {
    const profile = {
      adapter: "anthropic",
      models: ["anthropic/*"],
      gateway: { kind: "cloudflare", accountId: "acc", gatewayId: "gw", credential: "deployment:cf-aig", byok: true, metadata: { tenant: "t1", tier: 2, beta: true }, cache: { ttl: 60, skip: false }, retry: { maxAttempts: 3, delayMs: 500, backoff: "exponential" }, timeoutMs: 30_000 },
      compaction: "provider",
      media: { strategy: "inline" },
      providerOptions: { anthropic: { effort: "high", betas: ["server-side-fallback-2026-07-01"] } },
      headers: { "x-title": "karmi" },
    };
    expect(parseScopeConfig({ providers: { default: profile } }).providers?.default).toEqual(profile);
  });

  it("bounds gateway settings by the gateway's own limits and keeps media inline-only", () => {
    const gateway = { kind: "cloudflare", accountId: "acc", gatewayId: "gw" };
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", gateway: { ...gateway, metadata: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } } } } })).toThrowError(/\/providers\/default\/gateway\/metadata/);
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", gateway: { ...gateway, retry: { maxAttempts: 6 } } } } })).toThrowError(/\/providers\/default\/gateway\/retry\/maxAttempts/);
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", gateway: { ...gateway, kind: "vercel" } } } })).toThrowError(/\/providers\/default\/gateway\/kind/);
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", media: { strategy: "url" } } } })).toThrowError(/\/providers\/default\/media\/strategy/);
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", compaction: "auto" } } })).toThrowError(/\/providers\/default\/compaction/);
  });

  it("refuses authenticating headers as it refuses any other secret value", () => {
    for (const header of ["Authorization", "x-api-key", "cf-aig-authorization"]) {
      expect(() => parseScopeConfig({ providers: { default: { adapter: "a", headers: { [header]: "Bearer x" } } } })).toThrowError(new KarmiError("config.secret-value", `Secret values never enter the Scope config (at "/providers/default/headers/${header}"); store them with scope.credentials.put and reference them as scope:<name>.`));
    }
    expect(() => parseScopeConfig({ providers: { default: { adapter: "a", gateway: { kind: "cloudflare", accountId: "acc", gatewayId: "gw", token: "abc" } } } })).toThrowError(/config.secret-value|scope\.credentials\.put/);
  });

  it("exports JSON Schema for Platform editors", () => {
    expect(scopeConfigJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(scopeConfigJsonSchema.properties as object)).toEqual(["providers", "ceilings", "policy"]);
  });
});
