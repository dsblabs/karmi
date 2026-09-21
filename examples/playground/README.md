# karmi Playground

The Playground is the example webapp of karmi. It shows the Framework through guided scenarios that you run in a browser. Each scenario uses real model calls and real Framework behavior. The business systems are sample data.

This version has six browser scenarios:

- **Approve or deny a refund**
- **Change an Agent at runtime**
- **Tools, Skills and a Hook**
- **Control a Turn and its parked work**
- **Media and independent Thread Forks**
- **Schedules, external triggers and offline delivery**

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
3. Select **Change the instructions** or **Change the Fragment arguments**, then **Save the Spec**. The Scope stores a new version, and the page starts a new Thread. You do not deploy or start the Worker again.
4. Select **Run** again. The new Thread uses the new version, and earlier answers cannot change the result.
5. Select **Grant in the ceiling**, then **Save the Spec**. The Scope config has the ceiling `scheduling.maxPending: 5`, and the grant is not larger.
6. Select **Grant more than the ceiling**, then **Save the Spec**. The Scope rejects the Spec with the issue `capability.over-ceiling` and keeps the stored version.

You can also edit the JSON. A Spec that is not valid shows each issue with its code and its path. The route stores only the Agent `shop-assistant`, thus the editor cannot replace the Agent of a different scenario. A reset stores the starting Spec again as a new version and starts a new Thread.

The scenario needs no model feature other than text. The example code is in [`src/assistant.ts`](./src/assistant.ts).

## The Tools scenario

**Tools, Skills and a Hook** has an Agent that changes a sample stock system. The buttons above the prompt put one suggested prompt in the editor. You can edit each prompt.

| Prompt | What you see |
| --- | --- |
| **Deferred Tool** | The model sees only the name of `adjust_stock`. It calls `tool_search`, a `tools.loaded` event appears, and the stock changes. The result has `structuredContent`. |
| **Input that is not valid** | The schema of `adjust_stock` permits a change of 100 units at most. The Harness refuses a larger change with an error result, and the stock stays. |
| **Skill** | The model calls `use_skill`. A `tools.loaded` event names the Skill `restock`. Only then does the model have the Skill body and the Tool `order_supplier`. |
| **Policy deny** | The Permission Policy denies `delete_product`. The model cannot see the Tool, and a call to it runs nothing. |

The `after-tool` Hook `stock_audit` writes one line to **Audit log of the Hook** for each Tool call.

The **Permission Policy** card shows the rules of the Agent, and the **Tool annotations** card shows the hints of each Tool. The two cards are closed at first. Select a card to open it. One rule allows each Tool that has `readOnlyHint`. That rule allows `check_stock`, which no rule names.

The scenario needs a model that supports Tool calls. A small model can call `adjust_stock` before it loads the Tool. The call then gets an error result that tells the model to use `tool_search`. The example code is in [`src/stockroom.ts`](./src/stockroom.ts).

## The Turn control scenario

**Control a Turn and its parked work** has an Agent that packs the parcels of a sample dispatch system. The Agent has a `longRunning` grant of 6 Steps, thus a Turn parks for a continuation Approval before it packs every parcel. One Tool gives its call to a Job.

The composer has three more buttons. Each one acts on the Turn that runs or is parked now:

| Button | What it does |
| --- | --- |
| **Add to this Turn** | Sends the input with `steer`. The Harness adds it to the Turn at the next batch of Tool calls. |
| **Queue for the next Turn** | Sends the input without `steer`. A Thread runs one Turn at a time, thus the input waits. |
| **Cancel the Turn** | Ends the Turn with `turn.failed` and the reason `cancelled`. |

Do these steps:

1. Select **Run** with the **Budget** prompt. The Agent packs parcels until it spends the 6 Steps of its budget.
2. Read the **Turn** card. It shows the state of the Turn, what it waits for and the Steps that it spent.
3. Write an instruction and select **Add to this Turn**. The event `turn.input` with `steer` appears when the Turn continues.
4. Select **Allow** on the budget Approval. The Turn gets a new budget and packs the rest. A **Deny** ends the Turn with the stop reason `budget`. An Approval with no answer becomes a deny after 24 hours.
5. Select **Reset scenario**, then the **Job** prompt and **Run**. The Agent packs one parcel and books the courier.
6. Read the **Courier system** card. The Tool returned `{ pending: jobId }`, thus the tool Step parks and the Turn waits.
7. Select **Report the collection** or **Report a failure**. You play the part of the external courier system. The Turn continues with the result of the Job.

To see the limit of cancellation, select **Cancel the Turn** while the Turn waits for the courier Job. The Turn ends, and the booking that the Tool made stays in the sample courier system. The Framework cannot undo an action that a Tool finished in another system.

A reset cancels the parked Turn, deletes the Thread and restores the parcels and the courier system.

The scenario needs a model that supports Tool calls. The example code is in [`src/dispatch.ts`](./src/dispatch.ts). The Job route is in [`src/app.ts`](./src/app.ts).

## The media and Thread Forks scenario

**Media and independent Thread Forks** sends a real file through the multipart HTTP route. The Framework stores the bytes under the original Thread.

Do these steps:

1. Select a file, or select **Attach the sample file**. **Remove the file** clears the selection.
2. Select **Run**. The conversation shows the file below your message. The side column shows the stored media reference and a download link.
3. Send a second message. The file goes with one message only, thus this message sends only text.
4. Select the end of a completed Turn, then select **Fork the Thread**.
5. Inspect the separate event logs and media references of both Threads.
6. Select **Send to the Fork Thread** in the composer and run a prompt. Only the event log of the Fork grows.
7. Select **Delete the original**. The composer moves to the Fork.
8. Download the Fork's file. Its bytes remain available because the Fork owns a copy.

The download route accepts only media from the original or Fork of the current scenario. It refuses another Thread or Scope with a `404` answer. A reset deletes both scenario Threads and starts a new original Thread. It does not change another scenario or a Provider credential.

Images, audio, video and PDF can reach a compatible model. Other files stay stored and downloadable, but the model receives a file placeholder. Check the media support and size limit of your selected model.

The Agent is in [`src/media-forks.ts`](./src/media-forks.ts). The Fork, delete and download routes are in [`src/fork-routes.ts`](./src/fork-routes.ts).

## The Schedules and offline delivery scenario

**Schedules, external triggers and offline delivery** has an Agent at a sample reminder desk. The Agent has the `scheduling` grant, thus it has the built-in Tools `schedule`, `cancel_schedule` and `list_schedules`. Its Tool `send_reminder` has no Policy rule, thus each call waits for an Approval.

The **Pending Schedules** card creates a Schedule with one of three timing modes:

| Mode | What you do | What you see |
| --- | --- | --- |
| **Delayed** | Give a duration, for example `1m`. | The Schedule fires one time after the delay. Then the Thread deletes it. |
| **Timed** | Give a time as ISO 8601 text. The page suggests a time two minutes from now. | The Schedule fires one time at that time. A time in the past fires immediately. |
| **Recurring** | Give a cron expression with five fields. The zone is UTC. | The Schedule fires on each tick and stays in the list. The suggested `* * * * *` fires each minute. |

Do these steps:

1. Create a **Delayed** Schedule. The card lists it with the time of its next firing. The conversation shows `schedule.created`.
2. Wait for the delay. The conversation shows `schedule.fired`, then a Turn that starts with the Event `reminder.due`. The Agent asks to call `send_reminder`. Select **Allow**. The **Reminder system** card shows the reminder.
3. Create a **Recurring** Schedule, then select **Cancel the Schedule**. The conversation shows `schedule.cancelled`. Each tick of a recurring Schedule calls the model, so do not leave one active.
4. Select **Run** with the **Agent Schedule** prompt. The Agent calls the `schedule` Tool. Its Schedule appears in the same card with the Event `schedule.fired`.
5. Select **Send the supplier Event**. You play the part of a different system. A Turn starts with the Event `supplier.delivery`.
6. Select **Detach the Subscriber**. The page closes its WebSocket and reads new events with plain requests. A plain read of the event log is not a Subscriber.
7. Create a **Delayed** Schedule again. About one second after the Approval request, the **Sample inbox** card shows it. Select **Allow** in the inbox. The inbox then shows the completed Turn.
8. Select **Attach the Subscriber** and send the supplier Event again. The inbox gets no message, because an attached Subscriber stops offline delivery.

The sample inbox is sample data, not an email account. The Deliverer `sample_inbox` writes to it. Each Event of the scenario names the Deliverer in `channelRef.deliverer`, and the Thread keeps the last one. Delivery is at-least-once, thus the inbox ignores an event with a Thread key and `seq` that it has already.

In this scenario the page attaches with the WebSocket route, not with SSE. The Thread learns of a closed WebSocket at once. In local development, the Thread can learn of a closed SSE stream much later, and offline delivery stays off until then.

### The external trigger from a terminal

A trigger from a different system is your code: it finds the Thread and sends an Event. The Worker has a `scheduled` handler that calls the same function as **Send the supplier Event**. `wrangler.jsonc` has no cron, so no deployment calls the model on a timer. To call the handler in local development, run this command while `pnpm dev` runs. Use the port that `pnpm dev` printed:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

The page then shows a Turn with the Event `supplier.delivery`. To run the handler on a timer in your own deployment, add `"triggers": { "crons": ["0 9 * * *"] }` to `wrangler.jsonc`.

A reset cancels each pending Schedule, deletes the Thread and empties the inbox and the reminder system. No recurring Schedule stays active. It does not change another scenario or a Provider credential.

The scenario needs a model that supports Tool calls. The Agent, the Tool and the Deliverer are in [`src/reminders.ts`](./src/reminders.ts). The routes and the trigger function are in [`src/schedule-routes.ts`](./src/schedule-routes.ts). The `scheduled` handler is in [`src/worker.ts`](./src/worker.ts).

## Model limits

The refund scenario, the Tools scenario, the Turn control scenario and the Schedules scenario need a model that supports Tool calls. The Playground cannot check this for OpenRouter or a custom endpoint. Each of these scenarios shows a note before you run it. A model without Tool calls answers in text only, and no Tool call appears.

The media scenario shows a separate note about the media types that models can receive. Storage and download do not depend on model support.

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
- Local development does not run a cron trigger on its own. Call the `scheduled` handler as the Schedules scenario describes.

## Tests

| Command             | What it checks                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`         | The public HTTP routes of the Worker in workerd, with the scripted Provider of the Test kit. |
| `pnpm test:browser` | Each scenario, token access, reset and the layout at three screen sizes, in a browser.       |

Before the first browser check, run `pnpm exec playwright install chromium`. No test needs a credential.

The rules for a change to the page are in [`docs/ui.md`](./docs/ui.md).
