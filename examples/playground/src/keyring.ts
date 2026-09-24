// The `KARMI_KEYRING` document. The Worker and the `pnpm rotate-key` command both read it, so it imports only zod.
import { z } from "zod";

const keyringSchema = z.object({ active: z.string(), keys: z.record(z.string(), z.string()) });

/** The `KARMI_KEYRING` document: the id of the active key and each key by id. */
export type Keyring = z.infer<typeof keyringSchema>;

/** The ids of the key ring, which the page shows. It never holds a key. */
export interface KeyringView {
  active: string;
  keys: string[];
}

/** Decodes the `KARMI_KEYRING` document. Returns undefined when it is absent or not valid. */
export function decodeKeyring(text: string | undefined): Keyring | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = keyringSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.active in parsed.data.keys ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the ids of the key ring. Returns undefined when there is no valid key ring. */
export function keyringView(text: string | undefined): KeyringView | undefined {
  const keyring = decodeKeyring(text);
  return keyring && { active: keyring.active, keys: Object.keys(keyring.keys) };
}

/**
 * Adds a new key to the ring and makes it active. The ring keeps each old key, thus a credential that an old key
 * encrypts stays readable until a rewrap. The id of the new key is `v` and the next number.
 */
export function rotateKeyring(keyring: Keyring, key: string): Keyring {
  const numbers = Object.keys(keyring.keys).map((id) => Number(/^v(\d+)$/.exec(id)?.[1] ?? 0));
  const id = `v${String(Math.max(0, ...numbers) + 1)}`;
  return { active: id, keys: { ...keyring.keys, [id]: key } };
}

/** Keeps only the active key. Use it only after a rewrap of each Scope, because an old key can no longer decrypt. */
export function retireKeys(keyring: Keyring): Keyring {
  const key = keyring.keys[keyring.active];
  if (key === undefined) throw new Error(`The key ring has no key for its active id ${keyring.active}.`);
  return { active: keyring.active, keys: { [keyring.active]: key } };
}
