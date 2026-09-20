# karmi Playground

The Playground is the example webapp of karmi. It shows the Framework through guided scenarios that you run in a browser. Each scenario uses real model calls and real Framework behavior. The business systems are sample data.

This version has one scenario, **Approve or deny a refund**. The other scenarios are in the list with the status `incomplete`.

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

## Model limits

The scenario needs a model that supports Tool calls. The Playground cannot check this for OpenRouter or a custom endpoint, so the scenario shows a note before you run it. A model without Tool calls answers in text only, and no Approval appears.

A custom endpoint must have a public address. The Worker refuses requests to a private address such as `localhost`.

## Feature coverage

The **Feature coverage** page in the browser lists each feature group of karmi, the scenario that shows it and the check that verified it. The list is in [`src/scenarios.ts`](./src/scenarios.ts). A row without a scenario is not built yet.

## Local limits

- The state is in the local emulation, in `.wrangler/`. It is not in a Cloudflare account.
- This version has no deploy command and no removal command.

## Tests

| Command             | What it checks                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`         | The public HTTP routes of the Worker in workerd, with the scripted Provider of the Test kit. |
| `pnpm test:browser` | Allow, deny, token access and reset in a browser, with a scripted Provider.                  |

Before the first browser check, run `pnpm exec playwright install chromium`. No test needs a credential.
