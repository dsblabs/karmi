import { describe, expect, it } from "vitest";
import { generateKeyringKey, open, parseKeyring, rewrap, seal, type EnvelopeAad } from "../src/envelope";

const k1 = generateKeyringKey();
const k2 = generateKeyringKey();
const ringV1 = JSON.stringify({ deployment: "prod", active: "v1", keys: { v1: k1 } });
const ringV2 = JSON.stringify({ deployment: "prod", active: "v2", keys: { v1: k1, v2: k2 } });
const ringV2Only = JSON.stringify({ deployment: "prod", active: "v2", keys: { v2: k2 } });
const aad: EnvelopeAad = { deployment: "prod", scope: "acme", name: "anthropic", version: 1 };

describe("parseKeyring", () => {
  it("imports every key and names the active one", async () => {
    const ring = await parseKeyring(ringV2);
    expect(ring).toMatchObject({ deployment: "prod", active: "v2" });
    expect([...ring.keys.keys()]).toEqual(["v1", "v2"]);
    expect((await parseKeyring(JSON.stringify({ active: "a", keys: { a: k1 } }))).deployment).toBe("default");
  });

  it("rejects malformed rings with a pointed message", async () => {
    await expect(parseKeyring("nope")).rejects.toMatchObject({ code: "secrets.keyring.invalid" });
    await expect(parseKeyring(JSON.stringify({ active: "v1", keys: {} }))).rejects.toThrowError(
      'active key "v1" is not in keys.',
    );
    await expect(parseKeyring(JSON.stringify({ active: "v1", keys: { v1: "short" } }))).rejects.toThrowError(
      'key "v1" must be 32 base64-encoded bytes.',
    );
  });
});

describe("seal and open", () => {
  it("round-trips a value under the active key", async () => {
    const ring = await parseKeyring(ringV1);
    const envelope = await seal(ring, aad, "sk-ant-secret");
    expect(envelope.kek).toBe("v1");
    expect(envelope.ciphertext).not.toContain("sk-ant");
    expect(await open(ring, aad, envelope)).toBe("sk-ant-secret");
  });

  it("binds the ciphertext to its deployment, scope, name and version", async () => {
    const ring = await parseKeyring(ringV1);
    const envelope = await seal(ring, aad, "v");
    for (const moved of [{ scope: "other" }, { name: "openai" }, { version: 2 }, { deployment: "staging" }])
      await expect(open(ring, { ...aad, ...moved }, envelope)).rejects.toMatchObject({ code: "secrets.corrupt" });
  });

  it("opens under a decrypt-only old key and refuses a key no longer in the ring", async () => {
    const envelope = await seal(await parseKeyring(ringV1), aad, "v");
    expect(await open(await parseKeyring(ringV2), aad, envelope)).toBe("v");
    await expect(open(await parseKeyring(ringV2Only), aad, envelope)).rejects.toMatchObject({
      code: "secrets.kek.unknown",
    });
  });
});

describe("rewrap", () => {
  it("moves the wrapped DEK under the active key and keeps the ciphertext", async () => {
    const envelope = await seal(await parseKeyring(ringV1), aad, "v");
    const rotated = await parseKeyring(ringV2);
    const rewrapped = await rewrap(rotated, aad, envelope);
    expect(rewrapped).toMatchObject({ kek: "v2", ciphertext: envelope.ciphertext });
    expect(await open(await parseKeyring(ringV2Only), aad, rewrapped!)).toBe("v");
  });

  it("is a no-op for an envelope already on the active key", async () => {
    const ring = await parseKeyring(ringV2);
    expect(await rewrap(ring, aad, await seal(ring, aad, "v"))).toBeUndefined();
  });
});
