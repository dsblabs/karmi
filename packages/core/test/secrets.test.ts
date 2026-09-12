import { describe, expect, it } from "vitest";
import { KarmiError } from "../src/errors";
import {
  attemptTarget,
  fallbackReason,
  layerDeploymentCredentials,
  parseCredentialRef,
  INSPECT,
  redact,
  resolveProfileCredentials,
  sensitive,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
  type SecretsProvider,
  type SensitiveValue,
} from "../src/secrets";
import { memorySecrets } from "../src/testing/memory-secrets";

describe("SensitiveValue", () => {
  const value = sensitive("sk-ant-123");

  it("exposes its value only through expose()", () => {
    expect(value.expose()).toBe("sk-ant-123");
  });

  it("refuses JSON, string coercion and templating", () => {
    const refused = new KarmiError(
      "secrets.exposed",
      "A SensitiveValue cannot be serialised or coerced; only an adapter may expose() it.",
    );
    expect(() => JSON.stringify({ value })).toThrowError(refused);
    expect(() => String(value)).toThrowError(refused);
    expect(() => `${value}`).toThrowError(refused);
  });

  it("inspects as a placeholder and clones without its value", () => {
    expect(value[INSPECT]()).toBe("[SensitiveValue]");
    expect(structuredClone(value)).toEqual({});
  });

  it("is redacted wherever it sits in a structure, class instances included", () => {
    class Holder {
      constructor(readonly secret: SensitiveValue) {}
    }
    const when = new Date(0);
    expect(redact({ a: value, nested: [1, { b: value }], held: new Holder(value), when, keep: "x" })).toEqual({
      a: "[SensitiveValue]",
      nested: [1, { b: "[SensitiveValue]" }],
      held: { secret: "[SensitiveValue]" },
      when,
      keep: "x",
    });
  });
});

describe("credential references", () => {
  it("parses the two reference kinds and nothing else", () => {
    expect(parseCredentialRef("scope:anthropic")).toEqual({ source: "scope", name: "anthropic" });
    expect(parseCredentialRef("deployment:aig")).toEqual({ source: "deployment", name: "aig" });
    expect(parseCredentialRef("sk-ant-123")).toBeUndefined();
    expect(parseCredentialRef("scope:has space")).toBeUndefined();
  });
});

describe("layerDeploymentCredentials", () => {
  it("answers deployment references from createKarmi({ credentials }) and leaves the rest to the store", async () => {
    const store = memorySecrets();
    await store.put({ scope: "s", ref: "scope:own" }, sensitive("scope-value"));
    const secrets = layerDeploymentCredentials({ anthropic: "deploy-value" }, store);
    expect((await secrets.resolve({ scope: "s", ref: "deployment:anthropic" }))?.value.expose()).toBe("deploy-value");
    expect(await secrets.describe({ scope: "s", ref: "deployment:anthropic" })).toEqual({
      source: "deployment",
      version: 1,
      updatedAt: 0,
    });
    expect((await secrets.resolve({ scope: "s", ref: "scope:own" }))?.value.expose()).toBe("scope-value");
    expect(await secrets.resolve({ scope: "s", ref: "deployment:other" })).toBeUndefined();
  });

  it("keeps the optional methods of a class-based store", async () => {
    class Store implements SecretsProvider {
      puts: string[] = [];
      async resolve(): Promise<ResolvedCredential | undefined> {
        return undefined;
      }
      async describe(): Promise<CredentialInfo | undefined> {
        return undefined;
      }
      async put(ref: CredentialRef): Promise<CredentialInfo> {
        this.puts.push(ref.ref);
        return { source: "scope", version: 1, updatedAt: 0 };
      }
    }
    const store = new Store();
    const secrets = layerDeploymentCredentials({ k: "v" }, store);
    expect(await secrets.put?.({ scope: "s", ref: "scope:a" }, sensitive("x"))).toMatchObject({ version: 1 });
    expect(store.puts).toEqual(["scope:a"]);
    expect(secrets.revoke).toBeUndefined();
  });
});

describe("resolveProfileCredentials", () => {
  const store = memorySecrets();
  const seeded = (async () => {
    await store.put({ scope: "s", ref: "scope:anthropic" }, sensitive("sk"));
    await store.put({ scope: "s", ref: "scope:aig" }, sensitive("cf"));
  })();

  it("resolves the provider and gateway references and records which credential was used", async () => {
    await seeded;
    const result = await resolveProfileCredentials(store, "s", {
      adapter: "anthropic",
      credential: "scope:anthropic",
      gateway: { kind: "cloudflare", accountId: "a", gatewayId: "g", credential: "scope:aig" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.provider?.expose()).toBe("sk");
    expect(result.credentials.gateway?.expose()).toBe("cf");
    expect(result.use).toEqual({ ref: "scope:anthropic", source: "scope", version: 1 });
  });

  it("names the first missing reference", async () => {
    await seeded;
    expect(await resolveProfileCredentials(store, "s", { adapter: "anthropic", credential: "scope:nope" })).toEqual({
      ok: false,
      missing: "scope:nope",
    });
    expect(await resolveProfileCredentials(store, "s", { adapter: "anthropic" })).toEqual({
      ok: true,
      credentials: {},
    });
  });

  it("treats a revoked credential as missing", async () => {
    const own: SecretsProvider = memorySecrets();
    await own.put!({ scope: "s", ref: "scope:k" }, sensitive("v"));
    await own.revoke!({ scope: "s", ref: "scope:k" });
    expect(await own.describe({ scope: "s", ref: "scope:k" })).toMatchObject({
      version: 1,
      revokedAt: expect.any(Number),
    });
    expect(await resolveProfileCredentials(own, "s", { adapter: "a", credential: "scope:k" })).toEqual({
      ok: false,
      missing: "scope:k",
    });
  });
});

describe("fallback", () => {
  it("maps only the credential-shaped Provider errors to a reason", () => {
    expect(fallbackReason("auth")).toBe("auth");
    expect(fallbackReason("rate_limit")).toBe("rate_limit");
    expect(fallbackReason("invalid_request")).toBeUndefined();
    expect(fallbackReason("context_window_exceeded")).toBeUndefined();
  });

  const models = ["a/1", "a/2"];

  it("tries each model on the primary profile when nothing engaged the fallback", () => {
    expect(attemptTarget(models, undefined, 1, 1)).toEqual({ model: "a/1", fallback: false });
    expect(attemptTarget(models, undefined, 1, 2)).toEqual({ model: "a/2", fallback: false });
    expect(attemptTarget(models, undefined, 1, 3)).toBeUndefined();
  });

  it("retries the failed model on the fallback profile, then the rest on it too", () => {
    const engaged = { step: 1, attempt: 1, reason: "auth" as const };
    expect(attemptTarget(models, engaged, 1, 1)).toEqual({ model: "a/1", fallback: false });
    expect(attemptTarget(models, engaged, 1, 2)).toEqual({ model: "a/1", fallback: true });
    expect(attemptTarget(models, engaged, 1, 3)).toEqual({ model: "a/2", fallback: true });
    const late = { step: 1, attempt: 2, reason: "quota" as const };
    expect(attemptTarget(models, late, 1, 2)).toEqual({ model: "a/2", fallback: false });
    expect(attemptTarget(models, late, 1, 3)).toEqual({ model: "a/2", fallback: true });
  });

  it("starts every later Step of the Turn on the fallback profile", () => {
    const engaged = { step: 1, attempt: 1, reason: "auth" as const };
    expect(attemptTarget(models, engaged, 3, 1)).toEqual({ model: "a/1", fallback: true });
    expect(attemptTarget(models, engaged, 3, 2)).toEqual({ model: "a/2", fallback: true });
  });
});
