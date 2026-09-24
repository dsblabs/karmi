---
"@karmi/core": minor
---

Added the Playground scenario "Provider switching, Provider Tools and AI Gateway". Its Agent Spec is stored in the sample Scope and names a Provider profile. The scenario shows:

- A switch of the profile. The next Turn of the same Thread runs on the new Provider, and each model Step names its profile and model.
- The Provider Tools that karmi accepts on each profile. A grant on a different profile gets `capability.unavailable`.
- A `web_search` call that the Provider runs, next to a `shop_hours` call that the Harness runs.
- A Permission Policy rule that allows or denies `web_search`. An `ask` rule gets `policy.ask-on-provider-tool`.
- A profile that sends each call through Cloudflare AI Gateway. The Usage record has the gateway log id and no cost.

`pnpm setup` asks for an optional second Provider and an optional AI Gateway that you supply. `pnpm deploy` stores their settings, and `pnpm run remove` keeps the gateway.

The model ids of the Playground now start with the Provider id, for example `openai/gpt-5`. Reset the Agent Spec scenario and the MCP scenario one time after the update, because their stored Agents name the old model id.
