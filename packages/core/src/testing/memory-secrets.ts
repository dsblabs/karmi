import { KarmiError } from "../errors";
import {
  parseCredentialRef,
  type CredentialInfo,
  type CredentialRef,
  type SecretsProvider,
  type SensitiveValue,
} from "../secrets";

// The Test kit's SecretsProvider. It is a real implementation of the seam that keeps every credential in a Map.

interface Entry extends CredentialInfo {
  value: SensitiveValue;
}

/** The in-memory SecretsProvider of the Test kit, with every optional method implemented. */
export interface MemorySecrets extends Required<SecretsProvider> {
  /** Forgets everything, so one store can serve many tests. */
  clear(): void;
}

const key = (scope: string, name: string) => `${scope}/${name}`;
const invalid = (ref: string) =>
  new KarmiError(
    "credential.ref.invalid",
    `"${ref}" is not a credential reference (scope:<name> or deployment:<name>).`,
  );

/**
 * Creates an in-memory SecretsProvider. Both `scope:` and `deployment:` references are writable, so a test
 * can stage Deployment credentials too.
 */
export function memorySecrets(): MemorySecrets {
  const entries = new Map<string, Entry>();
  const locate = ({ scope, ref }: CredentialRef) => {
    const parsed = parseCredentialRef(ref);
    if (!parsed) throw invalid(ref);
    return { at: key(parsed.source === "scope" ? scope : "", parsed.name), source: parsed.source };
  };
  const info = ({ value: _, ...rest }: Entry): CredentialInfo => rest;
  return {
    clear: () => entries.clear(),
    async resolve(ref) {
      const entry = entries.get(locate(ref).at);
      return entry && entry.revokedAt === undefined ? { ...entry } : undefined;
    },
    async describe(ref) {
      const entry = entries.get(locate(ref).at);
      return entry && info(entry);
    },
    async put(ref, value) {
      const { at, source } = locate(ref);
      const entry: Entry = { source, version: (entries.get(at)?.version ?? 0) + 1, updatedAt: Date.now(), value };
      entries.set(at, entry);
      return info(entry);
    },
    async revoke(ref) {
      const { at } = locate(ref);
      const entry = entries.get(at);
      if (entry) entries.set(at, { ...entry, revokedAt: Date.now() });
    },
    async rewrap() {
      return { rewrapped: 0 };
    },
    async list(scope) {
      const prefix = key(scope, "");
      return [...entries.entries()]
        .filter(([at]) => at.startsWith(prefix))
        .map(([at, entry]) => ({ name: at.slice(prefix.length), ...info(entry) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
