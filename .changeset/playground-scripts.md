---
"@karmi/core": minor
---

Added the Playground scenario "Isolate Scripts". The scenario shows:

- A Script that calls sample Tools. Each nested Tool call shows under its `run_script` call with its `parentCallId`.
- The value, the error and the console lines of each Script.
- A Tool that needs an Approval and the network are out of reach for a Script.
- The `maxToolCalls`, `wallMs` and `cpuMs` limits, and cancellation of a running Script. Cloudflare stops a Script a few seconds after a small `cpuMs`. Local workerd does not enforce `cpuMs`.

`pnpm deploy` now asks whether to enable isolate Scripts. They need the Workers Paid plan. The Worker then gets the `KARMI_LOADER` binding.
