import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyringKey } from "../src/envelope";
import { envelopeSecrets } from "../src/envelope-secrets";
import { KarmiError } from "../src/errors";
import { consoleLogger } from "../src/logger";
import { isSensitiveValue, sensitive } from "../src/secrets";
import { karmi, provider } from "./worker";

// Storage is shared across the file, so each test works in a Scope of its own.
let n = 0;
const fresh = () => `cred${++n}`;

const k1 = generateKeyringKey();
const k2 = generateKeyringKey();
const ringV1 = JSON.stringify({ deployment: "test", active: "v1", keys: { v1: k1 } });
const ringV2 = JSON.stringify({ deployment: "test", active: "v2", keys: { v1: k1, v2: k2 } });
const ringV2Only = JSON.stringify({ deployment: "test", active: "v2", keys: { v2: k2 } });
const store = (keyring?: string) =>
  envelopeSecrets({ scopes: env.KARMI_SCOPES, ...(keyring !== undefined && { keyring }) });
const ref = (scope: string, name = "anthropic") => ({ scope, ref: `scope:${name}` });

describe("envelopeSecrets", () => {
  it("stores versions the Scope's ScopeConfig holds as ciphertext and resolves them to a SensitiveValue", async () => {
    const scope = fresh();
    const secrets = store(ringV1);
    expect(await secrets.put!(ref(scope), sensitive("sk-one"))).toMatchObject({ source: "scope", version: 1 });
    expect(await secrets.put!(ref(scope), sensitive("sk-two"))).toMatchObject({ source: "scope", version: 2 });
    const resolved = await secrets.resolve(ref(scope));
    expect(isSensitiveValue(resolved?.value)).toBe(true);
    expect(resolved?.value.expose()).toBe("sk-two");
    expect(resolved).toMatchObject({ source: "scope", version: 2 });
    expect(await secrets.describe(ref(scope))).toEqual({ source: "scope", version: 2, updatedAt: expect.any(Number) });
    expect(await secrets.list!(scope)).toEqual([
      { name: "anthropic", source: "scope", version: 2, updatedAt: expect.any(Number) },
    ]);
    expect(await secrets.resolve(ref(scope, "other"))).toBeUndefined();
    expect(await secrets.resolve({ scope, ref: "deployment:anthropic" })).toBeUndefined();
  });

  it("revoke drops the wrapped key: the credential is missing until a later put, which keeps counting versions", async () => {
    const scope = fresh();
    const secrets = store(ringV1);
    await secrets.put!(ref(scope), sensitive("sk-one"));
    await secrets.revoke!(ref(scope));
    expect(await secrets.resolve(ref(scope))).toBeUndefined();
    expect(await secrets.describe(ref(scope))).toMatchObject({ version: 1, revokedAt: expect.any(Number) });
    expect(await secrets.put!(ref(scope), sensitive("sk-again"))).toMatchObject({ version: 2 });
    expect((await secrets.resolve(ref(scope)))?.value.expose()).toBe("sk-again");
  });

  it("opens old envelopes under a decrypt-only key and rewraps them idempotently onto the active one", async () => {
    const scope = fresh();
    await store(ringV1).put!(ref(scope), sensitive("sk-old"));
    await store(ringV1).put!(ref(scope, "openai"), sensitive("sk-openai"));
    // The old key is gone from this ring, so nothing sealed under it opens.
    await expect(store(ringV2Only).resolve(ref(scope))).rejects.toMatchObject({ code: "secrets.kek.unknown" });
    const rotated = store(ringV2);
    expect((await rotated.resolve(ref(scope)))?.value.expose()).toBe("sk-old");
    expect(await rotated.rewrap!(scope)).toEqual({ rewrapped: 2 });
    expect(await rotated.rewrap!(scope)).toEqual({ rewrapped: 0 });
    expect((await store(ringV2Only).resolve(ref(scope)))?.value.expose()).toBe("sk-old");
    expect((await store(ringV2Only).resolve(ref(scope, "openai")))?.value.expose()).toBe("sk-openai");
    expect(await rotated.describe(ref(scope))).toMatchObject({ version: 1 });
  });

  it("refuses to store without a keyring and treats every Scope reference as missing", async () => {
    const scope = fresh();
    const secrets = store();
    expect(await secrets.resolve(ref(scope))).toBeUndefined();
    await expect(secrets.put!(ref(scope), sensitive("v"))).rejects.toThrowError(
      new KarmiError(
        "secrets.unavailable",
        "Scope credentials need the KARMI_KEYRING secret (or createKarmi({ secrets })).",
      ),
    );
    await expect(store(ringV1).put!({ scope, ref: "deployment:shared" }, sensitive("v"))).rejects.toMatchObject({
      code: "credential.readOnly",
    });
  });

  it("destroying the Scope deletes every wrapped key with the tombstone", async () => {
    const scope = fresh();
    const secrets = store(ringV1);
    await secrets.put!(ref(scope), sensitive("sk"));
    await karmi.scope(scope).destroy();
    await expect(secrets.resolve(ref(scope))).rejects.toMatchObject({ code: "scope.destroyed" });
  });
});

describe("scope.credentials", () => {
  it("is write-only: put and revoke, with metadata reads and no value anywhere", async () => {
    const scope = karmi.scope(fresh());
    expect(await scope.credentials.put("anthropic", "sk-ant")).toMatchObject({ source: "scope", version: 1 });
    expect(await scope.credentials.describe("anthropic")).toMatchObject({ version: 1 });
    expect(await scope.credentials.list()).toEqual([expect.objectContaining({ name: "anthropic", version: 1 })]);
    expect(JSON.stringify(await scope.credentials.list())).not.toContain("sk-ant");
    await scope.credentials.revoke("anthropic");
    expect(await scope.credentials.describe("anthropic")).toMatchObject({ revokedAt: expect.any(Number) });
    expect(await scope.credentials.rewrap()).toEqual({ rewrapped: 0 });
    expect(await scope.credentials.describe("missing")).toBeUndefined();
  });
});

describe("scope.providers.test", () => {
  afterEach(() => provider.script(["OK"]));

  it("makes one real call under the profile's credentials and reports the Provider's verdict", async () => {
    const scope = karmi.scope(fresh());
    await scope.config.set({
      providers: { own: { adapter: "fake", models: ["*"], credential: "scope:anthropic" } },
    });
    const seen: (string | undefined)[] = [];
    provider.script((ctx) => {
      seen.push(ctx.options.credentials?.provider?.expose());
      return "pong";
    });
    expect(await scope.providers.test("own", { model: "fake/m" })).toMatchObject({
      ok: false,
      profile: "own",
      error: { code: "auth", message: 'Credential "scope:anthropic" is missing.' },
    });
    await scope.credentials.put("anthropic", "sk-tenant");
    expect(await scope.providers.test("own", { model: "fake/m" })).toEqual({
      ok: true,
      profile: "own",
      model: "fake/m",
      credential: { ref: "scope:anthropic", source: "scope", version: 1 },
    });
    expect(seen).toEqual(["sk-tenant"]);
    provider.script([{ part: "error", error: { code: "quota", message: "Over quota", retryable: false } }]);
    expect(await scope.providers.test("own", { model: "fake/m" })).toMatchObject({
      ok: false,
      error: { code: "quota" },
    });
    await expect(scope.providers.test("own")).rejects.toMatchObject({ code: "provider.model.required" });
    await expect(scope.providers.test("nope")).rejects.toMatchObject({ code: "provider.profile.unknown" });
  });
});

describe("consoleLogger", () => {
  it("redacts SensitiveValues from every field", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      consoleLogger({ scope: "s", key: sensitive("sk") }).info("hello", { nested: { token: sensitive("t") } });
      expect(info).toHaveBeenCalledWith(
        JSON.stringify({
          level: "info",
          message: "hello",
          scope: "s",
          key: "[SensitiveValue]",
          nested: { token: "[SensitiveValue]" },
        }),
      );
    } finally {
      info.mockRestore();
    }
  });
});
