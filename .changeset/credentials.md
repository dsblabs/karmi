---
"@karmi/core": patch
"@karmi/anthropic": patch
"@karmi/ai-sdk": patch
---

Provider credentials: the `SecretsProvider` seam with `SensitiveValue`, an envelope-encrypting default store over `KARMI_KEYRING` with a versioned key ring, `rewrap` and `revoke`, `createKarmi({ credentials, secrets })`, `scope.credentials.put/describe/list/revoke/rewrap` and `scope.providers.test`. Profiles opt into `fallback: { profile, on }` to a Deployment profile; the Thread resolves credentials just before each model Step, records the source, version and any fallback on `step.started`, and never persists a value. Adapters receive `credentials` in the call options; the Anthropic adapter's `credentials` option is gone.
