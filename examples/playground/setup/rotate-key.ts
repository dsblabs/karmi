// The key rotation of the local Playground: `pnpm rotate-key`. It adds a new key to the `KARMI_KEYRING` line of
// `.dev.vars` and makes it active. `pnpm rotate-key --retire` then keeps only the active key. Each other line of the
// file stays as it is, thus the Provider credential and the access token do not change.
import { decodeKeyring, retireKeys, rotateKeyring, type Keyring } from "../src/keyring.ts";
import { randomBase64 } from "./cli.ts";

/**
 * Returns the text of `.dev.vars` with a rotated key ring, and the new ring. With `retire`, the ring keeps only its
 * active key. Throws when the file has no valid `KARMI_KEYRING` line.
 */
export function rotateDevVars(text: string, key: string, retire: boolean): { text: string; keyring: Keyring } {
  const line = /^KARMI_KEYRING='(.*)'$/m.exec(text);
  const current = decodeKeyring(line?.[1]);
  if (!line || !current) throw new Error("`.dev.vars` has no valid KARMI_KEYRING. Run `pnpm setup` first.");
  const keyring = retire ? retireKeys(current) : rotateKeyring(current, key);
  // A function as the replacement, because a key can contain `$`, which a replacement string would read.
  return { text: text.replace(line[0], () => `KARMI_KEYRING='${JSON.stringify(keyring)}'`), keyring };
}

async function main(): Promise<void> {
  const { chmod, readFile, writeFile } = await import("node:fs/promises");
  const file = new URL("../.dev.vars", import.meta.url);
  const retire = process.argv.includes("--retire");
  const { text, keyring } = rotateDevVars(await readFile(file, "utf8").catch(() => ""), randomBase64(32), retire);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  const ids = Object.keys(keyring.keys).join(", ");
  console.log(`Wrote examples/playground/.dev.vars. The active key is ${keyring.active}. The ring has: ${ids}.`);
  console.log(
    retire
      ? "Start `pnpm dev` again. A credential that an old key encrypts can no longer be read."
      : "Start `pnpm dev` again, then select Rewrap the credentials in the Scope lifecycle scenario.",
  );
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("rotate-key.ts")) await main();
