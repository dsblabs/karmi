import * as z from "zod/mini";
import { KarmiError } from "./errors";
import { firstIssue, pointer } from "./validate";

// This module implements envelope encryption for the default credential store. Every credential gets its
// own data encryption key (DEK), which is wrapped by a versioned Deployment key encryption key (KEK) from
// the `KARMI_KEYRING` Worker secret. Old KEKs stay in the ring for decryption only. `rewrap` moves what
// they protect under the active KEK.

const KEY_BYTES = 32;
const IV_BYTES = 12;

const KeyringSchema = z.strictObject({
  // The deployment name is bound into every ciphertext, so a row copied between Deployments that share a
  // key still fails to open.
  deployment: z.optional(z.string().check(z.minLength(1))),
  active: z.string().check(z.minLength(1)),
  keys: z.record(z.string().check(z.minLength(1)), z.string().check(z.minLength(1))),
});

/** The parsed `KARMI_KEYRING` secret: the Deployment name, the active key version and the imported keys. */
export interface Keyring {
  /** The Deployment name bound into every ciphertext. Defaults to `"default"`. */
  deployment: string;
  /** The version of the key that wraps new data keys. */
  active: string;
  /** The AES-GCM keys by version. Only the active key can encrypt. */
  keys: ReadonlyMap<string, CryptoKey>;
}

/**
 * What the store persists per credential version: the wrapped data key and the value encrypted under it, both
 * AES-GCM.
 */
export interface Envelope {
  /** The version of the key ring key that wrapped `dek`. */
  kek: string;
  /** The wrapped data key, as base64. */
  dek: string;
  /** The credential value encrypted under the data key, as base64. */
  ciphertext: string;
}

/**
 * The additional authenticated data bound into both encryption layers of an Envelope. A ciphertext moved
 * to another Deployment, Scope, name or version does not open.
 */
export interface EnvelopeAad {
  deployment: string;
  scope: string;
  name: string;
  version: number;
}

const invalid = (message: string) => new KarmiError("secrets.keyring.invalid", `KARMI_KEYRING is invalid: ${message}`);

/**
 * Parses the `KARMI_KEYRING` secret, whose shape is `{ deployment?, active, keys: { <version>: <base64 32 bytes> } }`.
 * Throws `secrets.keyring.invalid` when it does not parse.
 */
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
    // Only the active key may wrap. Every other key is imported as decrypt-only.
    const usages: ("encrypt" | "decrypt")[] = version === active ? ["encrypt", "decrypt"] : ["decrypt"];
    keys.set(version, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages));
  }
  return { deployment, active, keys };
}

/** A fresh random 32-byte key as base64, the form a `KARMI_KEYRING` entry holds. */
export function generateKeyringKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Encrypts `value` under a fresh data key wrapped by the active key of `keyring`, bound to `aad`. */
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

/**
 * Decrypts `envelope` under `keyring`, bound to `aad`. Throws `secrets.kek.unknown` when the wrapping key
 * has left the ring and `secrets.corrupt` when the ciphertext does not open.
 */
export async function open(keyring: Keyring, aad: EnvelopeAad, envelope: Envelope): Promise<string> {
  const kek = keyring.keys.get(envelope.kek);
  if (!kek) throw unknownKek(envelope.kek);
  const additional = encodeAad(aad);
  const dekBytes = await decrypt(kek, envelope.dek, additional);
  const dek = await crypto.subtle.importKey("raw", dekBytes, "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await decrypt(dek, envelope.ciphertext, additional));
}

/**
 * The same data key and ciphertext wrapped under the active key of `keyring`, or undefined when it already is.
 */
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

// The key order is fixed because the AAD must encode identically at seal and open.
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
