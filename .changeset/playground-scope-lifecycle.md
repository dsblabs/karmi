---
"@karmi/core": minor
---

Added the Playground scenario "Scope lifecycle, credentials and key rotation". The scenario runs in a disposable Scope and shows:

- A suspension that parks a new Turn, and a resume that continues it.
- A destroy with the progress of the Destroy walk. A reset moves to a new Scope id, because a destroyed id stays reserved.
- A Scope credential that no route returns. You can test it, revoke it and see the next model Step fall back to the credential of setup.

The new command `pnpm rotate-key` adds a key to the local key ring. The page then rewraps each Scope credential with the new key.
