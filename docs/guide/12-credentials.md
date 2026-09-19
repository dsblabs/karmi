---
title: Credentials
---

# Credentials

A credential is a secret that karmi stores or resolves by name. A Provider profile and an MCP server name a credential by reference. They never contain the value. [Providers](05-providers.md) shows how a Provider profile uses a reference.

## References

| Reference           | Owner          | Source                               |
| ------------------- | -------------- | ------------------------------------ |
| `deployment:<name>` | The Deployment | `createKarmi({ credentials })`       |
| `scope:<name>`      | The Scope      | `scope.credentials.put(name, value)` |

Give Worker secrets to `createKarmi({ credentials })`. Do not write a literal value in the code.

The value is never part of an Agent Spec, a config revision, an event or a Turn snapshot. The Thread resolves the reference immediately before each model Step and discards the value after the call. A Provider gets the value as a `SensitiveValue`. This wrapper refuses JSON, string conversion and inspection, and it gives the value only through `expose()`. The `step.started` event records the profile, the source and the version of the credential, and each Credential fallback.

## The credentials of a Scope

`scope.credentials` is write-only. No method returns a value.

| Method             | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `put(name, value)` | Stores the value as the next version. Returns the `CredentialInfo`.          |
| `describe(name)`   | Returns the `CredentialInfo`, or `undefined` when there is no credential.    |
| `list()`           | Returns the `CredentialInfo` and the `name` of each credential.              |
| `revoke(name)`     | Makes the credential missing from the next model Step, also during a Turn.   |
| `rewrap()`         | Encrypts each credential again with the active key. Returns `{ rewrapped }`. |

A `CredentialInfo` has `source`, `version`, `updatedAt` and, after a revocation, `revokedAt`. This sample replaces the credential of a tenant and returns the new version:

```ts
import type { Scope } from "@karmi/core";

export async function rotateTenantKey(scope: Scope, apiKey: string): Promise<number> {
  const info = await scope.credentials.put("anthropic", apiKey);
  return info.version;
}
```

The next model Step uses the new version.

## The key ring

The default store encrypts each credential with a data key of its own. The active key of the `KARMI_KEYRING` Worker secret encrypts that data key. The rows are in the ScopeConfig of the Scope. The secret is a JSON document with this shape:

```jsonc
{ "active": "v1", "keys": { "v1": "<base64 key>" } }
```

`generateKeyringKey()` returns a new key in the correct format. This script prints one key:

```ts
import { generateKeyringKey } from "@karmi/core";

console.log(generateKeyringKey());
```

This command stores the JSON document as the Worker secret:

```sh
pnpm exec wrangler secret put KARMI_KEYRING
```

### Rotate the key

1. Add a new key to `keys` and make it `active`. Keep the old keys.
2. Store the new document with `wrangler secret put`.
3. Run `scope.credentials.rewrap()` for each Scope.
4. Remove an old key only after you rewrap each Scope.

Until step 3 is complete, the store uses an old key only to decrypt. `rewrap()` is idempotent. This sample rewraps a list of Scopes:

```ts
import type { Karmi } from "@karmi/core";

export async function rewrapScopes(karmi: Karmi, scopeIds: string[]): Promise<number> {
  let total = 0;
  for (const id of scopeIds) {
    const { rewrapped } = await karmi.scope(id).credentials.rewrap();
    total += rewrapped;
  }
  return total;
}
```

## A Secrets provider of your own

`createKarmi({ secrets })` replaces the default store with a `SecretsProvider` of the Platform, for example a company vault. `resolve` and `describe` are required. `put`, `revoke`, `rewrap` and `list` are optional. `createKarmi({ credentials })` continues to answer the `deployment:<name>` references. This sample resolves Scope credentials from a vault service:

```ts
import { createKarmi, sensitive, type CredentialInfo, type CredentialRef, type SecretsProvider } from "@karmi/core";

const vaultUrl = "https://vault.example.com";

interface VaultEntry extends CredentialInfo {
  value: string;
}

async function read(ref: CredentialRef): Promise<VaultEntry | undefined> {
  const response = await fetch(`${vaultUrl}/${ref.scope}/${encodeURIComponent(ref.ref)}`);
  return response.ok ? response.json() : undefined;
}

const vaultSecrets: SecretsProvider = {
  async resolve(ref) {
    const entry = await read(ref);
    if (!entry || entry.revokedAt !== undefined) return undefined;
    const { value, ...info } = entry;
    return { ...info, value: sensitive(value) };
  },
  async describe(ref) {
    const entry = await read(ref);
    if (!entry) return undefined;
    const { value: _value, ...info } = entry;
    return info;
  },
};

export const karmi = createKarmi({ catalogue: {}, secrets: vaultSecrets });
```

A store with no `put` is read-only for karmi. `scope.credentials.put` then fails. The Test kit uses an in-memory store. Refer to [Testing](13-testing.md).

## Other uses of a reference

- A static header of an MCP server. Refer to [Remote MCP servers](11-mcp.md).
- The `client.secret` of an OAuth MCP server.
- The `gateway.credential` of a Provider profile. Refer to [Providers](05-providers.md).
