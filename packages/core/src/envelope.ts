import * as z from "zod/mini";
import { KarmiError } from "./errors";
import { firstIssue, pointer } from "./validate";

// Envelope encryption for the default credential store: every credential gets its own data key (DEK),
// wrapped by a versioned Deployment key (KEK) from the `KARMI_KEYRING` Worker secret. Old KEKs stay in
// the ring for decryption only; `rewrap` moves what they protect under the active one.

const KEY_BYTES = 32;
const IV_BYTES = 12;

const KeyringSchema = z.strictObject({
  /** Bound into every ciphertext, so a row copied between Deployments sharing a key still fails to open. */
  deployment: z.optional(z.string().check(z.minLength(1))),
  active: z.string().check(z.minLength(1)),
  keys: z.record(z.string().check(z.minLength(1)), z.string().check(z.minLength(1))),
});

export interface Keyring {
  deployment: string;
  active: string;
  keys: ReadonlyMap<string, CryptoKey>;
}

/** What the store persists per credential version: the wrapped DEK and the value under it, both AES-GCM. */
export interface Envelope {
  /** The KEK version that wrapped `dek`. */
  kek: string;
  dek: string;
  ciphertext: string;
}

/** Bound into both layers; a ciphertext moved to another Scope, name or version does not open. */
export interface EnvelopeAad {
  deployment: string;
  scope: string;
  name: string;
  version: number;
}

const invalid = (message: string) => new KarmiError("secrets.keyring.invalid", `KARMI_KEYRING is invalid: ${message}`);

/** Parses the keyring secret: `{ deployment?, active, keys: { <version>: <base64 32 bytes> } }`. */
export async function parseKeyring(json: string): Promise<Keyring> {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw invalid("not JSON.");
  }
  const result = z.safeParse(KeyringSchema, document);
  if (!result.success) {
    const issue = firstIssue(result.error);
    throw invalid(`at "${pointer(issue.path)}": ${issue.message}`);
  }
  const { deployment = "default", active } = result.data;
  if (!(active in result.data.keys)) throw invalid(`active key "${active}" is not in keys.`);
  const keys = new Map<string, CryptoKey>();
  for (const [version, encoded] of Object.entries(result.data.keys)) {
    const bytes = tryBase64(encoded);
    if (bytes?.byteLength !== KEY_BYTES) throw invalid(`key "${version}" must be ${KEY_BYTES} base64-encoded bytes.`);
    keys.set(version, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return { deployment, active, keys };
}

/** A fresh 32-byte key, base64: what a `KARMI_KEYRING` entry holds. */
export function generateKeyringKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export async function seal(keyring: Keyring, aad: EnvelopeAad, value: string): Promise<Envelope> {
  const kek = keyring.keys.get(keyring.active);
  if (!kek) throw unknownKek(keyring.active);
  const dekBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dek = await crypto.subtle.importKey("raw", dekBytes, "AES-GCM", false, ["encrypt"]);
  const additional = encodeAad(aad);
  return {
    kek: keyring.active,
    dek: await encrypt(kek, dekBytes, additional),
    ciphertext: await encrypt(dek, new TextEncoder().encode(value), additional),
  };
}

export async function open(keyring: Keyring, aad: EnvelopeAad, envelope: Envelope): Promise<string> {
  const kek = keyring.keys.get(envelope.kek);
  if (!kek) throw unknownKek(envelope.kek);
  const additional = encodeAad(aad);
  const dekBytes = await decrypt(kek, envelope.dek, additional);
  const dek = await crypto.subtle.importKey("raw", dekBytes, "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await decrypt(dek, envelope.ciphertext, additional));
}

/** The same DEK and ciphertext under the active KEK, or `undefined` when it already is. */
export async function rewrap(keyring: Keyring, aad: EnvelopeAad, envelope: Envelope): Promise<Envelope | undefined> {
  if (envelope.kek === keyring.active) return undefined;
  const old = keyring.keys.get(envelope.kek);
  const active = keyring.keys.get(keyring.active);
  if (!old) throw unknownKek(envelope.kek);
  if (!active) throw unknownKek(keyring.active);
  const additional = encodeAad(aad);
  const dekBytes = await decrypt(old, envelope.dek, additional);
  return { kek: keyring.active, dek: await encrypt(active, dekBytes, additional), ciphertext: envelope.ciphertext };
}

const unknownKek = (version: string) =>
  new KarmiError(
    "secrets.kek.unknown",
    `Key "${version}" is not in KARMI_KEYRING; a rotated-out key must stay until rewrap.`,
  );

/** Fixed key order: the AAD must encode identically at seal and open. */
function encodeAad({ deployment, scope, name, version }: EnvelopeAad): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ deployment, scope, name, version }));
}

async function encrypt(key: CryptoKey, data: Uint8Array, additionalData: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, data));
  const out = new Uint8Array(IV_BYTES + encrypted.byteLength);
  out.set(iv);
  out.set(encrypted, IV_BYTES);
  return toBase64(out);
}

async function decrypt(key: CryptoKey, encoded: string, additionalData: Uint8Array): Promise<Uint8Array> {
  const bytes = tryBase64(encoded);
  try {
    if (!bytes) throw new Error("not base64");
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData },
        key,
        bytes.subarray(IV_BYTES),
      ),
    );
  } catch {
    throw new KarmiError("secrets.corrupt", "A stored credential does not open under its key and binding.");
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function tryBase64(encoded: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}
