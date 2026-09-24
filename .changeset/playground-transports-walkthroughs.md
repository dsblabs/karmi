---
"@karmi/core": minor
---

Added the Playground scenario "REST, SSE and WebSocket" and the terminal walkthrough "Test kit, doctor, deployment and removal".

The scenario uses only the routes of `@karmi/http`. It shows:

- Guided REST requests with their answers, and the error answers `401`, `400` and `404` with their codes.
- An event stream through Server-Sent Events or the WebSocket of the Thread. On the socket, Run sends a `send` frame and the page shows the `ack`.
- A dropped stream that connects again with `after`. The stream first sends each stored event after the last `seq` of the page.

The walkthrough gives the commands and the expected results for the Test kit, record and replay of a real Provider, and `karmi doctor`. `pnpm dev:record` and `pnpm record` save the calls of the front desk Agent, and `pnpm test test/replay.test.ts` replays them. A copy of `wrangler.jsonc` without one migration shows a doctor failure and its fix, with no change to your configuration.
