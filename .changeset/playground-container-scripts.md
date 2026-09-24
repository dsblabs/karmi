---
"@karmi/core": minor
---

Added the Playground scenario "Container Scripts, files and artifacts". The scenario shows:

- A shell or Python Script that reads sample files in `/in` and writes artifacts to `/out`. You can download each artifact.
- A long process that becomes a Job, with its progress, its completion and its cancellation.
- The network allow-list of a container Script: one allowed hostname and one denied hostname.

`pnpm dev` still needs no Docker. The new command `pnpm dev:containers` runs container Scripts in local Docker containers.

`pnpm deploy` now asks whether to enable container Scripts. They need the Workers Paid plan and Docker on your computer. `pnpm run remove` deletes the container application and its images.
