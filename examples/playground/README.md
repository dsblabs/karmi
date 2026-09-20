# karmi Playground

The Playground is the example webapp of karmi. It shows the Framework through guided scenarios that you run in a browser. Each scenario uses real model calls and real Framework behavior. The business systems are sample data.

This version has three browser scenarios:

- **Approve or deny a refund**
- **Change an Agent at runtime**
- **Tools, Skills and a Hook**

It also has Cloudflare deployment and removal commands.

## Run it locally

You need a credential for one of these Providers:

- OpenAI
- Anthropic
- Google Gemini
- OpenRouter
- A custom endpoint that is compatible with the OpenAI API

You do not need a Cloudflare account or a Cloudflare login. Run these commands from the root of the repository:

```sh
pnpm install
pnpm build
cd examples/playground
pnpm setup
pnpm dev
```

1. `pnpm setup` asks for the Provider, the model and the credential. It prints your access token.
2. `pnpm dev` starts the Worker with the local Cloudflare emulation of wrangler. It prints the URL.
3. Open the URL and enter the access token.

`pnpm setup` writes `.dev.vars`. Git ignores this file. The file holds the Provider credential, the access token and the key ring. Run `pnpm setup` again to change the Provider or the model. The command keeps the access token and the key ring.

The terminal shows the credential while you type it.

## Access

The Worker checks the access token on each route below `/api` and `/threads`. A request without the token gets a `401` answer. The browser files have no data, so the Worker serves them without the token. There is no signup.

The browser shows the Provider and the model. No route returns the Provider credential.

## The refund scenario

The Agent has two Tools that change or read a sample order system:

- `get_order` is read-only. The Permission Policy of the Agent allows it.
- `refund_order` has no Policy rule. Thus the Framework stops each call and asks for an Approval.

Do these steps:

1. Read the sample order. Edit the suggested prompt if you want.
2. Select **Run**. The page shows each Tool call and its result.
3. Select **Allow** or **Deny** on the Approval.
4. Read the Approval outcome and the sample order. Allow changes the order to `refunded`. Deny does not change it.
5. Open **Event log** to see each Thread event.

The state stays until you select **Reset scenario**. A reset cancels a Turn that waits, deletes the Thread and restores the sample order. It does not change `.dev.vars` or a stored credential.

The example code is in [`src/refund.ts`](./src/refund.ts). The routes are in [`src/app.ts`](./src/app.ts).

## The Agent Spec scenario

**Change an Agent at runtime** has no Agent in the code. The Worker stores the Agent Spec of `shop-assistant` in the sample Scope with `scope.agents.put`. The Prompt of the Agent has one text entry and the Fragment `shop_policy`.

Do these steps:

1. Read **What the Prompt entries give now**. It shows the text of each Prompt entry. The Fragment text comes from the same function that the Harness calls at the start of each Turn.
2. Select **Run**. The Agent answers with the return time of 30 days.
3. Select **Change the instructions** or **Change the Fragment arguments**, then **Save the Spec**. The Scope stores a new version. You do not deploy or start the Worker again.
4. Select **Run** again. The new Turn uses the new version.
5. Select **Grant in the ceiling**, then **Save the Spec**. The Scope config has the ceiling `scheduling.maxPending: 2`, and the grant is not larger.
6. Select **Grant more than the ceiling**, then **Save the Spec**. The Scope rejects the Spec with the issue `capability.over-ceiling` and keeps the stored version.

You can also edit the JSON. A Spec that is not valid shows each issue with its code and its path. A reset stores the starting Spec again as a new version and starts a new Thread.

The scenario needs no model feature other than text. The example code is in [`src/assistant.ts`](./src/assistant.ts).

## The Tools scenario

**Tools, Skills and a Hook** has an Agent that changes a sample stock system. The buttons above the prompt put one suggested prompt in the editor. You can edit each prompt.

| Prompt | What you see |
| --- | --- |
| **Deferred Tool** | The model sees only the name of `adjust_stock`. It calls `tool_search`, a `tools.loaded` event appears, and the stock changes. The result has `structuredContent`. |
| **Input that is not valid** | The schema of `adjust_stock` permits a change of 100 units at most. The Harness refuses a larger change with an error result, and the stock stays. |
| **Skill** | The model calls `use_skill`. A `tools.loaded` event names the Skill `restock`. Only then does the model have the Skill body and the Tool `order_supplier`. |
| **Policy deny** | The Permission Policy denies `delete_product`. The model cannot see the Tool, and a call to it runs nothing. |

The `after-tool` Hook `stock_audit` writes one line to **Audit log of the Hook** for each Tool call. The **Permission Policy** card shows the rules of the Agent.

The scenario needs a model that supports Tool calls. A small model can call `adjust_stock` before it loads the Tool. The call then gets an error result that tells the model to use `tool_search`. The example code is in [`src/stockroom.ts`](./src/stockroom.ts).

## Model limits

The refund scenario and the Tools scenario need a model that supports Tool calls. The Playground cannot check this for OpenRouter or a custom endpoint, so each of these scenarios shows a note before you run it. A model without Tool calls answers in text only, and no Tool call appears.

A custom endpoint must have a public address. The Worker refuses requests to a private address such as `localhost`.

## Feature coverage

The **Feature coverage** page in the browser lists each feature group of karmi, the scenario that shows it and the check that verified it. The list is in [`src/scenarios.ts`](./src/scenarios.ts). A row without a scenario is not built yet.

## Deploy to Cloudflare

Run setup first.

Start the guided deployment command:

```sh
pnpm deploy
```

The command checks your Cloudflare login and lists your accounts. It then creates these resources in the account that you select:

- One Worker with a distinct deployment name.
- Two Queues for work and failed messages.
- One R2 bucket for media.

The command stores the Provider credential, access token and key ring as Worker secrets. It writes non-secret Provider settings as Worker variables.

The command records ownership in `.deployments/<name>/manifest.json` before it creates resources. Git ignores this directory. Keep the manifest until removal finishes.

Run the same command with the deployment name to recover from an interruption:

```sh
pnpm deploy karmi-playground-a1b2c3d4
```

You can supply existing resources. The manifest marks them as external, and removal preserves them:

```sh
pnpm deploy karmi-playground-a1b2c3d4 --bucket existing-media --queue existing-queue --dead-letter-queue existing-dlq
```

The base deployment does not create optional services. Future optional integrations can add owned or external resources to the same manifest.

## Remove a Cloudflare deployment

Give the exact deployment name to the removal command:

```sh
pnpm run remove karmi-playground-a1b2c3d4
```

The command removes the owned Worker, Queues and R2 bucket. Worker deletion removes its Durable Object storage. The command preserves each external resource in the manifest.

If cleanup fails, the command lists each remaining resource and keeps its ownership record. Fix the reported problem. Then run the command again. A repeated removal skips resources that a prior attempt removed.

## Local limits

- The state is in the local emulation, in `.wrangler/`. It is not in a Cloudflare account.
- Local development and a deployed Worker use separate state.

## Tests

| Command             | What it checks                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`         | The public HTTP routes of the Worker in workerd, with the scripted Provider of the Test kit. |
| `pnpm test:browser` | Each scenario, token access and reset in a browser, with a scripted Provider.                |

Before the first browser check, run `pnpm exec playwright install chromium`. No test needs a credential.
