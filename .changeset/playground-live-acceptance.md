---
"@karmi/core": patch
---

Fixed the Playground after a live acceptance with a real model and a Cloudflare deployment.

- The deployment command is `pnpm run deploy`. `pnpm deploy` is a command of pnpm, thus it did not start the script as you typed it.
- A retry of `pnpm run deploy` keeps the `workers.dev` address of the manifest. It no longer deploys two times.
- A reset of a scenario stores its Agent again after `pnpm setup` changes the model. Before, the Turns of the scenario failed with `agent.spec.invalid`.
- The **Budget** prompt of the Turn control scenario spends the budget also with a model that packs each parcel in one batch. The **Job** prompt names the parcel, thus the Turn does not spend its budget before the answer.
- The **Ledger system** card shows the entry of a held Tool call while the call runs.
- The **Feature coverage** page has a **Scenarios** table with the starting data, the prerequisites and the local limits of each scenario. Each feature row tells what the live acceptance verified and what it did not verify.
