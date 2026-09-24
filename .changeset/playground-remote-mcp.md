---
"@karmi/core": minor
---

Added the Playground scenario "Remote MCP Tools and OAuth Connections". You register a real remote MCP server from the page, in a disposable Scope. The scenario shows:

- The Tools of the server, and each call under the Permission Policy of the Agent.
- A static header value as a write-only Scope credential, and the failed tool list after a revocation.
- A user-level OAuth Connection: the consent flow, a `connect` Approval in the conversation, the resumed call and a denied consent.
- A private address that the Scope config refuses, and a failed tool list with the error of the Framework.

A reset destroys the disposable Scope with the registration, the credential and the Connection. OAuth needs the new variable `PLAYGROUND_ORIGIN`. `pnpm deploy` sets it to the `workers.dev` address.
