---
"@karmi/core": patch
---

Provider seam: plain-JSON `Message`/`ContentBlock`, `ProviderEvent`, `Usage` and tagged `ProviderError` types, the `Provider` interface (`stream`, `countTokens?`, `capabilities`), full per-profile `ProviderConfig` (gateway, `compaction`, `media`, `providerOptions`, `headers`), cross-provider replay rules in `prepareMessages`, and the `@karmi/core/testing` kit with `fakeProvider`, `reply.*`, `recordingProvider` and `fakeProvider.fromRecording`.
