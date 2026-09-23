# karmi Playground

The Playground is the example webapp of karmi. It shows the Framework through guided scenarios that you run in a browser. Each scenario uses real model calls and real Framework behavior. The business systems are sample data.

This version has twelve browser scenarios:

- **Approve or deny a refund**
- **Change an Agent at runtime**
- **Tools, Skills and a Hook**
- **Control a Turn and its parked work**
- **Media and independent Thread Forks**
- **Schedules, external triggers and offline delivery**
- **Compaction and recovery**
- **Child Threads and their Approvals**
- **User Memory and Scope isolation**
- **Usage records, costs and logs**
- **Isolate Scripts**
- **Knowledge ingestion and document search**

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

The token opens two sample Scopes, `sample-a` and `sample-b`. A request acts in `sample-a`. A Thread route with the query parameter `scope=sample-b` acts in `sample-b`. Only the Memory scenario uses it. A request that names a different Scope gets a `401` answer.

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
4. Select **Run** with the **Agent Schedule** prompt. The Agent calls the `schedule` Tool. Its Schedule appears in the same card with the Event `schedule.fired`. The **List** and **Agent cancel** prompts make the Agent call `list_schedules` and `cancel_schedule`. A Schedule of the Agent names no Deliverer. The Thread keeps the last one, so its Turn goes to the same inbox.
5. Select **Send the supplier Event**. You play the part of a different system. A Turn starts with the Event `supplier.delivery`.
6. Select **Detach the Subscriber**. The page closes its WebSocket and reads new events with plain requests. A plain read of the event log is not a Subscriber.
7. Create a **Delayed** Schedule again. About one second after the Approval request, the **Sample inbox** card shows it. Select **Allow** in the inbox. The inbox then shows the completed Turn.
8. Select **Attach the Subscriber** and send the supplier Event again. The inbox gets no message, because an attached Subscriber stops offline delivery. A second browser tab with this scenario is also a Subscriber, so close it before you detach.

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

## The Compaction and recovery scenario

**Compaction and recovery** has an Agent that keeps a sample ledger. Its Tool `read_ledger` has `readOnlyHint`, and its Tool `post_entry` has no `idempotentHint`. The Agent Spec has a small `context`: a window of 2000 tokens, a reserve of 500 and 500 kept tokens. A real Agent inherits the window of its model, which is much larger.

### Compaction

Before each model Step, the Harness compares the context with the window minus the reserve. The context is the usage that the Provider reported for the last model Step, plus an estimate of what the log got since. Over the limit, a compact Step runs before the model Step.

Do these steps:

1. Select **Run** with the **Long conversation** prompt. The Agent reads the ledger and describes each entry.
2. Select **Run** again with the same prompt, one or two more times. The conversation shows the line `The context is over the window minus the reserve`, then a **Compaction** card with the summary and the first kept `seq`. The number of Turns depends on the length of the answers of your model.
3. Read the Agent answer after the card. The Agent continues with the summary in place of the earlier Turns. The check is that the Turn completes, not the words of the model.
4. Open **Event log**. The events before the first kept `seq` are still there. Compaction does not change the log. The next request has the Prompt, the summary and the events from the first kept `seq`.
5. Select **Compact the Thread** while the Thread is idle. The compact Step runs with the trigger `manual` and your instructions. A compact Step that finds nothing before the kept tokens drops nothing, and the conversation says so.

The **Compaction** card shows the tokens before and after, as the Harness estimated them. The summarising call has its own Usage record with the kind `compaction`.

### Recovery from a terminal

Cloudflare can stop a Durable Object at any time. A stopped dev server does the same to each Thread in the local emulation. The Thread continues from its stored event log. This walkthrough shows it with a Tool call that runs when the server stops. Run it with `pnpm dev` in one terminal and a second terminal for the commands.

1. Select **Hold the ledger**. Each Tool call now writes its change, then waits up to five minutes before it returns its result.
2. Select **Run** with the **Unsafe call** prompt. The Agent calls `post_entry`. The **Ledger system** card shows the new entry, and the Tool card stays at `running`.
3. In the terminal of `pnpm dev`, stop the server with `Ctrl+C`. The state of the local emulation stays in `.wrangler/`.
4. Start the server again with `pnpm dev`. Reload the page. The conversation shows the Turn from the event log: the Tool call has no result, and the **Turn** card shows the state `running`.
5. Select **Release the ledger**. Then read the event log from the terminal. Use the port that `pnpm dev` printed, your access token and the Thread key from the **Event log**:

   ```sh
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8787/threads/$THREAD_KEY/events" | jq '.[] | {seq, type, attempt, interrupted, reason}'
   ```

6. Wait for the recovery. The watchdog alarm of the Thread fires about one minute after the last Step began. A new input to the Thread starts the recovery at once, thus send a message with **Run** if you do not want to wait. The event log then has these events, in this sequence:

   | Event | What it shows |
   | --- | --- |
   | `turn.resumed` with `reason: "recovered"` | The Thread continues the Turn from its event log. |
   | `step.started` with `attempt: 2` | The tool Step runs again. Each Step has three attempts. |
   | `tool.result` for `post_entry` with `isError: true` and `interrupted: { attempt: 2 }` | The call has no `idempotentHint`, thus the Harness does not run it again. The result tells the model that the call may have taken effect. |
   | `tool.call` and `tool.result` for `read_ledger` | The Agent checks the ledger, as its instructions say. The entry is there one time. |
   | `turn.completed` | The Agent tells what it found. |

7. Reset the scenario and repeat the steps with the **Safe call** prompt. The Agent calls `read_ledger`, which has `readOnlyHint`. After the recovery, the log has a second `step.started` with `attempt: 2` and one `tool.result` for `read_ledger` with `isError: false`. The Harness ran the call again, because a read-only call is safe to repeat.

A Tool result that is in the log before the interruption stays, also when it is in the same Step as the interrupted call. The Harness does not run that call again, and the before-tool Hooks do not run again for it. The hold route can start the hold from a number of entries: `{"held":true,"from":8}` holds the ledger once it has eight entries. The Worker tests use it to give one Step a finished call and an interrupted one.

Two checks cover this recovery, each in its own environment:

- The Worker tests in `test/compaction.test.ts` run in workerd with the scripted Provider. They abort the Thread Durable Object while the Tool call waits, then fire the watchdog alarm with the Clock of the Test kit. An abort ends the code in flight and its storage access. It is not the same as a stopped process.
- The walkthrough above is the local check, with `wrangler dev` and the scripted Provider of the browser checks. It shows that the state survives a stop of the server and that the watchdog alarm fires after the start.

No check runs in a Cloudflare account. A local result is not proof for a deployed Worker. Cloudflare resets a Durable Object for a code update or a platform failure, and the guide describes what the Harness does then.

The scenario needs a model that supports Tool calls. The Agent and the Tools are in [`src/ledger.ts`](./src/ledger.ts). The hold route is in [`src/app.ts`](./src/app.ts).

## The Delegation scenario

**Child Threads and their Approvals** has two Agents. The parent Agent `manager` has the `delegation` grant and names `buyer` in `delegates`. The grant gives it the Tool `delegate` of the Framework. The child Agent `buyer` has two Tools that read or change a sample purchase system:

- `list_suppliers` is read-only. The Permission Policy of the child allows it.
- `place_order` has no Policy rule. Thus each call waits for an Approval.

Do these steps:

1. Select **Run** with the **Delegate** prompt. The parent calls `delegate` with the Agent name and the task text. The conversation shows the line `The delegate call started the child Thread` and a **Child Thread** card. The **Child Threads** card in the side column shows the child with its parent key and the call id.
2. Read the **Child Thread** card. It shows the task, each Tool call and the answer of the child. The child has new context: it gets the task text only. Your message stays in the parent Thread. The card reads the event log of the child.
3. Read the **Turn** card. The parent Turn is parked. The delegate call is a Job, and the Turn waits for the child. The card shows the children of the Turn: how many started and how many are active.
4. Read the Approval. The child asked to call `place_order`. The parent Thread shows the Approval again, with the label of the child. Select **Allow** or **Deny**. The answer goes down to the child Thread.
5. Read the outcome. **Allow** places the order, and the **Purchase system** card shows it. **Deny** gives the child an error result, and the child says that no order was placed. In both cases, the final answer of the child becomes the result of the `delegate` call, and the parent reports it.
6. Read the **Usage records** card. The parent and the child have their own records, each with its Thread id. A record of the child also names the call of the parent. No record occurs two times.
7. Select **Reset scenario**, then the **Two children** prompt and **Run**. The parent calls `delegate` two times in one Step. Two child Threads run at the same time, and each one has its own Approval.
8. Select **Cancel the Turn** while the children wait. The parent Turn ends with `turn.failed` and the reason `cancelled`. Each child Turn ends the same way, and its card says so. An order that a child placed before the cancel stays in the sample purchase system.

Open **Event log** to see the parent log. It has `delegation.started` and `delegation.completed` with the key of the child, and the Approval of the child with a `child` field. It has no Tool call of the child.

A child id is the parent id, then the call id of the `delegate` call. A reset cancels the parent Turn, which cancels each child. It then deletes each child Thread and the parent Thread, and restores the sample data. A delete of the parent does not reach a child, thus the reset lists the children with `scope.threads.list` and the parent key.

The scenario needs a model that supports Tool calls. A small model can call `place_order` without the supplier list, or put the two tasks in one `delegate` call. The Agents and the Tools are in [`src/purchases.ts`](./src/purchases.ts). The state of the scenario is in [`src/runtimes.ts`](./src/runtimes.ts). The reset route is in [`src/app.ts`](./src/app.ts).

## The Memory and Scope isolation scenario

**User Memory and Scope isolation** has a concierge Agent with a `memory` block in its Spec. The block declares one Profile field, `roast`, and keeps Notes. The block gives the Agent the built-in Tools `remember` and `recall`. At the start of each Turn, the Harness puts a Memory Fragment in the Prompt. The Fragment has the Profile and the 20 most recent Notes of the User.

The scenario runs in two sample Scopes, `sample-a` and `sample-b`, for the same User `operator`. The composer has a select that names the Scope that receives the Turn. Each Scope has a **Memory** card with the Profile, the Notes, the Users with a stored Memory and the count of Threads since the reset.

Do these steps:

1. Select **Run** with the **Remember** prompt. The Agent calls `remember` with the field `roast` and a Note. The **Memory of operator in sample-a** card shows both, and the User is in the list of Users with a Memory.
2. Select **Start a new Thread** in the card. The conversation is empty, because a new Thread has no earlier event. Select **Run** with the **Ask** prompt. The Agent answers from the Memory Fragment, with no Tool call. Open **Event log** to see that the Thread has no event of the earlier Thread.
3. Select **Run** with the **Search the Notes** prompt. The Agent calls `recall`, and the result has the Note. `recall` searches the Notes with full-text search, thus a query word must occur in the Note.
4. Select **Forget the User**. The card is empty. Select **Start a new Thread** and run the **Ask** prompt again. The Agent does not know the preference.
5. Select **Send in the Scope sample-b** in the composer, then run the **Remember** and the **Ask** prompts. The **Memory of operator in sample-b** card gets its own Memory, and the card of `sample-a` does not change. The same User has one Memory for each Scope.
6. Select **Read the sample-b Thread as sample-a** in the **Scope boundary** card. The request gets a `404` answer with the code `thread.notFound`. A Thread key names a Thread in the Scope of the request only. karmi has no operation that crosses Scopes.

The **Profile fields of the Agent** card shows the schema of the Profile. The Harness checks each `remember` call against it and refuses a field that the Agent does not declare. The **Memory** cards read the Memory with `scope.users.memory.get` and list the Users with `scope.users.memory.list`. **Forget the User** calls `scope.users.memory.delete`. Only a Turn writes a Memory.

The state stays until you select **Reset scenario**. A reset cancels and deletes each Thread of the scenario in both Scopes, deletes the Memory of the User in both Scopes and starts a new Thread in each one. It does not change another scenario or a Provider credential.

The scenario needs a model that supports Tool calls. A small model can answer from its own guess in place of the Memory Fragment. Check the event log: an answer from the Fragment has no Tool call. The Agent is in [`src/concierge.ts`](./src/concierge.ts). The routes are in [`src/memory-routes.ts`](./src/memory-routes.ts). The mapping of the token to a Scope is in [`src/app.ts`](./src/app.ts).

## The Knowledge scenario

**Knowledge ingestion and document search** has a librarian Agent with a `knowledge` block in its Spec. The block names two corpora of the sample Scope:

| Corpus | Mode | What the Agent gets |
| --- | --- | --- |
| `handbook` | `search` | The read-only Tool `search_handbook`. It returns the Passages of the Retriever as JSON. |
| `notices` | `inline` | The full text of the corpus in its Prompt, under `# Knowledge: notices`, at the start of each Turn. |

The Retriever is the built-in `fts5Retriever`: SQLite full-text search with BM25 ranking. It returns at most 10 Passages and needs no external service. A query word must occur in a document.

The scenario starts with three handbook documents and two notices. The **Corpus** cards list the documents that the scenario ingested. The Framework has no route that lists the documents of a corpus, thus the list is sample data of the scenario. The corpus itself is in the Knowledge Durable Object of the Framework.

Do these steps:

1. Select **Search the handbook** in the **Passages of a search** card. The card shows the Passages that `scope.knowledge("handbook").search` returned. Each Passage has `docId`, `text`, `score`, `seq` and the `metadata` of its document. A higher `score` is a better match.
2. Select **Run** with the **Search** prompt. The Agent calls `search_handbook`. The Tool result has the same Passages, and the answer names the document id. No Approval stops the call, because the Tool is read-only.
3. Select **Update the refund policy** in the **Ingest a document** card, then **Ingest the document**. The document keeps its id, thus the new text replaces the old one. Search again: the Passage has the new text, and the Agent answers with it.
4. Select **Run** with the **Inline** prompt. The Agent answers from the notices in its Prompt, with no Tool call. Open **Event log**: the Turn has no `tool.call`. The **Corpus notices** card shows the text that the Prompt gets.
5. Select **Add a notice over the inline limit**, then **Ingest the document**. The card shows the error of `inline()`. Run the **Inline** prompt again: the Turn fails with the message of the limit. Select **Delete** on the document `long`, and the next Turn works again.
6. Select **Ingest 40 handbook pages** in the **Bulk ingest Job** card. An ingest of more than 32 documents returns `{ pending: jobId }`. The card shows the progress of the Job, which the page reads each second. While the Job is pending, each other write to the corpus gets a `409` answer with the code `knowledge.busy`. Search for `lot 3` during the Job: a search sees each document that the Job committed.
7. Select **Run** with the **Bulk** prompt after the Job completed. The Agent finds the page of bean lot 12.
8. Select **Delete** on a document. A search no longer finds it. Select **Destroy the corpus**. The corpus leaves the list in **Corpora of the Scope**, which `scope.knowledge.list` gives. The Tool stays, because the Agent Spec names the corpus, and a search finds nothing. The next ingest makes the corpus again.

Inline and search differ in what the model sees and in their limits:

- With `inline`, the model sees the full corpus in each Turn and needs no Tool call. The corpus must stay under 32,000 Unicode code points, the exported constant `KNOWLEDGE_INLINE_LIMIT`. Over it, the Turn fails before the model call.
- With `search`, the model sees only the Passages that its query matches. The corpus has no size limit, and a Tool call and its Step come with each search.

Vector and hybrid retrieval are not in the scenario. They need Workers AI through the `KARMI_AI` binding, or a Vectorize index, which local development does not have. The **Feature coverage** page lists them without a scenario.

The state stays until you select **Reset scenario**. A reset destroys each corpus, cancels and deletes the Thread and ingests the starting documents again. The Framework refuses a destroy while an ingest Job is pending. Thus a reset during a bulk ingest gets a `409` answer with the code `knowledge.busy`, and it changes nothing. Wait for the Job, then reset again. A reset does not change another scenario or a Provider credential.

The scenario needs a model that supports Tool calls. A small model can answer from its own guess in place of a search. Check the event log for the `search_handbook` call. The Agent and the sample documents are in [`src/librarian.ts`](./src/librarian.ts). The routes are in [`src/knowledge-routes.ts`](./src/knowledge-routes.ts).

## The Usage and logging scenario

**Usage records, costs and logs** runs one Agent and a sample UsageHandler. The Agent has the Tool `lookup_ticket`. That Tool logs credential-shaped fields. karmi redacts them before the Logger stores the line.

Do these steps:

1. Select **Run** with the **Ask the desk** prompt. The Agent answers in text. It does not know its spend. The **Usage records** card shows the spend.
2. Read the **Usage records** card. The top part shows the Scope, the Agent, the User, the Thread and the model of the records. **Reported cost** is the sum of the reported costs, and it tells how many records had one. The table has one row for each `usage.recorded` event: its `seq`, its tokens and its cost. The key of a record is `threadId:seq`.
3. Read the **UsageHandler** card. The Queue delivers the batch some seconds after the Turn. Until then, the card shows **waiting for the Queue**, and the page checks again every 2 seconds. The handler stores each record under its key.
4. Select **Fail the next batch**, then **Run** again. The card shows a failed delivery. The Queue retries, and the handler stores the record. The Turn does not fail.
5. Select **Deliver the last batch again**. The handler skips each key that it stored before. The card shows `duplicate, skipped`. The button shows after the handler stored a batch.
6. Select **Run** with the **Look up a ticket** prompt. The **Logs** card shows the line with its level, its message and its fields. The `apiKey` and `authorization` fields are `[REDACTED]`.
7. Select **Show redaction**. The card shows `redactFields` on the same sample object, before and after.
8. Open **Example child Usage record**. The JSON has a `parent` field. This scenario does not start a child Thread.

karmi never prices tokens. A missing cost is not zero. A child Thread of a Delegation records its own spend and sets `parent`.

The state stays until you select **Reset scenario**. A reset deletes the Thread and the inspection data. It does not change another scenario or a Provider credential. A batch of the old Thread that the Queue delivers after the reset does not show.

The scenario needs a model that supports Tool calls. The Agent, the UsageHandler and the Logger are in [`src/observability.ts`](./src/observability.ts).

## The isolate Scripts scenario

**Isolate Scripts** has an Agent with the `scripts` grant of the tier `isolate`. The grant gives the model the Tool `run_script` of the Framework. Each call runs one JavaScript module in a new Dynamic Worker, through the `KARMI_LOADER` binding. The Agent has four Tools that read or change a sample order system:

- `find_orders` and `read_order` are read-only. The Permission Policy allows them.
- `pack_box` packs an open order. A Policy rule allows it by name.
- `cancel_order` has no Policy rule. A direct call waits for an Approval.

The grant has `tools: "allowed"`, thus a Script gets each Tool that the Policy allows. It also gets the Tools of the Framework that the Agent has, for example `tool_search`. Its limits are `cpuMs: 50`, `wallMs: 10000` and `maxToolCalls: 10`. They are lower than the defaults, thus a Script reaches each one in a few seconds.

Each suggested prompt has a Script. The instructions tell the model to run it as it is. You can edit the code.

| Prompt | What you see |
| --- | --- |
| **Tool calls** | The Script calls `find_orders`, then `read_order` for each open order. The **Script runs** card shows the value `{ count: 3, total: 105 }`, the console line and four nested Tool calls. |
| **Tool that needs an Approval** | The Script logs the names in `tools`. `cancel_order` is not there, because a Script cannot wait for an Approval. The call throws `tools.cancel_order is not a function`. No Approval request occurs, and the order stays open. |
| **Network** | `fetch` throws. The isolate has no network access. |
| **Tool-call limit** | The Script asks for 12 calls. The Harness refuses the eleventh and ends the Script with `limit_exceeded: maxToolCalls`. |
| **Time limit** | The Script waits for 60 seconds. The Harness ends it after 10 seconds with `limit_exceeded: wallMs`. |
| **CPU limit** | The Script runs a long loop. On Cloudflare, it fails with `limit_exceeded: cpuMs`. Local workerd does not enforce `cpuMs`, thus the Script finishes in local development. |
| **Cancel** | The Script packs one open order each two seconds. Select **Cancel the Turn** after the first box. The Script stops and packs no more boxes. The boxes that it packed stay packed. |

In the conversation, the card of each `run_script` call lists the Tool calls of its Script. The model does not see them: it gets only the result of `run_script`. The **Script runs** card shows, for each Script, the value or the error, a plain explanation of a known error, the console lines and each nested call with its call id and its `parentCallId`. The parent is the call id of the `run_script` call, in the form `{threadId}:{seq}`. Open **Event log** to see the `tool.call` and `tool.result` events with `parentCallId`.

The **Script grant and Permission Policy** card shows the grant and the rules of the Agent. It is closed at first.

A reset cancels the Turn, which stops a Script that runs. It then deletes the Thread and restores each order. No Script work stays. It does not change another scenario or a Provider credential.

The local development server has the `KARMI_LOADER` binding. A Cloudflare deployment has it only when you select isolate Scripts. See [Deploy to Cloudflare](#deploy-to-cloudflare). Without the binding, the scenario shows why it is not available.

The scenario needs a model that supports Tool calls. A small model can change the code before it calls `run_script`. The **Script runs** card shows the code that ran. The Agent and the Tools are in [`src/scripts.ts`](./src/scripts.ts).

## Model limits

These scenarios need a model that supports Tool calls: refund, Tools, Turn control, Schedules, Compaction and recovery, Delegation, Memory, Knowledge, Usage and logging, and isolate Scripts.

The Playground cannot check this for OpenRouter or a custom endpoint. Each of these scenarios shows a note before you run it. A model without Tool calls answers in text only, and no Tool call appears.

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

The command then asks whether to enable isolate Scripts. They need Dynamic Workers, and Dynamic Workers need the [Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/). A yes gives the Worker the Worker Loader binding `KARMI_LOADER`. The binding is part of the Worker, thus it creates no other resource. The manifest records the answer, and a retry uses it again. To change the answer, deploy with a new deployment name. Without isolate Scripts, the **Isolate Scripts** scenario tells why it is not available.

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

The command removes the owned Worker, Queues and R2 bucket. It deletes all objects in the owned R2 bucket before it deletes the bucket. Worker deletion removes its Durable Object storage and its Worker Loader binding. The command preserves each external resource in the manifest.

If cleanup fails, the command lists each remaining resource and keeps its ownership record. Fix the reported problem. Then run the command again. A repeated removal skips resources that a prior attempt removed.

## Local limits

- The state is in the local emulation, in `.wrangler/`. It is not in a Cloudflare account.
- Local development and a deployed Worker use separate state.
- Local development does not run a cron trigger on its own. Call the `scheduled` handler as the Schedules scenario describes.
- Local workerd does not enforce the `cpuMs` limit of a Script. Only a deployed Worker shows it.

## Tests

| Command             | What it checks                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`         | The public HTTP routes of the Worker in workerd, with the scripted Provider of the Test kit. |
| `pnpm test:browser` | Each scenario, token access, reset and the layout at three screen sizes, in a browser.       |

Before the first browser check, run `pnpm exec playwright install chromium`. No test needs a credential.

The rules for a change to the page are in [`docs/ui.md`](./docs/ui.md).
