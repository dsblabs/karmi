---
"@karmi/core": patch
---

Fixed the Playground after a live acceptance with a real model and a Cloudflare deployment.

- Changed the deployment command in the docs to `pnpm run deploy`. `pnpm deploy` is a command of pnpm, thus it did not start the script as you typed it.
- Fixed a retry of `pnpm run deploy`, which deployed two times. It now keeps the `workers.dev` address of the manifest.
- Fixed the Turns of a scenario after `pnpm setup` changed the model. They failed with `agent.spec.invalid`. A reset of the scenario now stores its Agent again.
- Changed the **Budget** prompt of the Turn control scenario, thus a model that packs each parcel in one batch also spends the budget. Changed the **Job** prompt to name the parcel, thus the Turn does not spend its budget before the answer.
- Fixed the **Ledger system** card, which did not show the entry of a held Tool call while the call ran.
- Added a **Scenarios** table to the **Feature coverage** page, with the starting data, the prerequisites and the local limits of each scenario. Each feature row now tells what the live acceptance verified and what it did not verify.
