import { KarmiError } from "./errors";
import { open, parseKeyring, rewrap, seal, type EnvelopeAad, type Keyring } from "./envelope";
import { keys } from "./keys";
import { remote, unwrap } from "./outcome";
import type { ScopeConfigDurableObject, StoredCredential } from "./scope-config-do";
import {
  parseCredentialRef,
  sensitive,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
  type SecretsProvider,
  type SensitiveValue,
} from "./secrets";

// The default SecretsProvider: Scope credentials envelope-encrypted under the KARMI_KEYRING Worker
// secret, with the ciphertext rows in the Scope's own ScopeConfig Durable Object. Deployment references
// are not held here; `createKarmi({ credentials })` answers those in front of any store.

export interface EnvelopeSecretsOptions {
  /** The `KARMI_SCOPES` namespace; the rows live with the Scope. */
  scopes: DurableObjectNamespace;
  /** The `KARMI_KEYRING` secret; absent, every Scope reference is missing and `put` refuses. */
  keyring?: string;
}

export function envelopeSecrets(options: EnvelopeSecretsOptions): SecretsProvider {
  return new EnvelopeStore(options);
}

/** Only Scope references live here; anything else is simply not ours to answer. */
function scopeName({ ref }: CredentialRef): string | undefined {
  const parsed = parseCredentialRef(ref);
  return parsed?.source === "scope" ? parsed.name : undefined;
}

function info({ envelope: _, name: __, ...rest }: StoredCredential): CredentialInfo {
  return rest;
}

class EnvelopeStore implements SecretsProvider {
  private ring: Promise<Keyring> | undefined;

  constructor(private readonly options: EnvelopeSecretsOptions) {}

  private keyring(): Promise<Keyring> {
    if (this.options.keyring === undefined)
      throw new KarmiError(
        "secrets.unavailable",
        "Scope credentials need the KARMI_KEYRING secret (or createKarmi({ secrets })).",
      );
    this.ring ??= parseKeyring(this.options.keyring);
    return this.ring;
  }

  private stub(scope: string) {
    return remote<ScopeConfigDurableObject>(this.options.scopes, keys.config(scope));
  }

  private aad(ring: Keyring, scope: string, name: string, version: number): EnvelopeAad {
    return { deployment: ring.deployment, scope, name, version };
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const name = scopeName(ref);
    if (name === undefined) return undefined;
    const stored = await unwrap(this.stub(ref.scope).credentialGet(ref.scope, name));
    if (!stored?.envelope) return undefined;
    // A stored credential the Deployment lost the ring for is an outage, never "missing" for a fallback to eat.
    const ring = await this.keyring();
    const value = await open(ring, this.aad(ring, ref.scope, name, stored.version), stored.envelope);
    return { ...info(stored), value: sensitive(value) };
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo | undefined> {
    const name = scopeName(ref);
    if (name === undefined) return undefined;
    const stored = await unwrap(this.stub(ref.scope).credentialGet(ref.scope, name));
    return stored && info(stored);
  }

  async put(ref: CredentialRef, value: SensitiveValue): Promise<CredentialInfo> {
    const name = scopeName(ref);
    if (name === undefined)
      throw new KarmiError("credential.readOnly", `Only scope:<name> credentials can be stored; "${ref.ref}" cannot.`);
    const ring = await this.keyring();
    const current = await unwrap(this.stub(ref.scope).credentialGet(ref.scope, name));
    const version = (current?.version ?? 0) + 1;
    const envelope = await seal(ring, this.aad(ring, ref.scope, name, version), value.expose());
    return unwrap(this.stub(ref.scope).credentialPut(ref.scope, name, version, envelope));
  }

  async revoke(ref: CredentialRef): Promise<void> {
    const name = scopeName(ref);
    if (name === undefined) return;
    await unwrap(this.stub(ref.scope).credentialRevoke(ref.scope, name));
  }

  async rewrap(scope: string): Promise<{ rewrapped: number }> {
    const ring = await this.keyring();
    let rewrapped = 0;
    for (const stored of await unwrap(this.stub(scope).credentialList(scope))) {
      if (!stored.envelope || stored.envelope.kek === ring.active) continue;
      const next = await rewrap(ring, this.aad(ring, scope, stored.name, stored.version), stored.envelope);
      if (next && (await unwrap(this.stub(scope).credentialRewrap(scope, stored.name, stored.version, next))))
        rewrapped++;
    }
    return { rewrapped };
  }

  async list(scope: string): Promise<(CredentialInfo & { name: string })[]> {
    const stored = await unwrap(this.stub(scope).credentialList(scope));
    return stored.map((row) => ({ name: row.name, ...info(row) }));
  }
}
