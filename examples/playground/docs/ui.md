# Playground UI

This page gives the design of the Playground page. The page is three files in `public/` with no build step and no UI library. Keep it that way.

## Goals

- The page feels fast. Each action shows a result at once, before the Worker answers.
- The page is obvious. The operator finds each control in the zone where it belongs.
- The page works on a desktop, a tablet and a phone, in light and in dark colours.

## Zones

A scenario view has four zones. Put new content in one of them. Do not add a zone.

| Zone | Element | What belongs there |
|---|---|---|
| Title bar | `.intro` | The title, the status, the summary, the closed notes, the link to the example code and **Reset scenario** |
| Conversation | `#steps` | What the operator and the Agent did, in the sequence of the Thread events |
| Composer | `.composer` | The prompt, the suggested prompts, and one `.row` with **Run**, the Turn controls and the status line |
| Side column | `.side` | The state of the sample system, the controls that change the scenario and the event log |

- An action on the full scenario goes in the title bar.
- An action that sends a Turn goes in the composer.
- An action on the sample system or the Agent goes in the card that shows that data.
- The conversation is the largest zone at each size. Do not add content above it that is open by default.
- The function in `PANELS` gives the cards of the side column for a scenario. The first card is the data that the scenario changes. On a phone, the side column goes below the conversation.

## Components

Use these classes. Add a component only when none of them fits, and add it to this list in the same change.

| Class | Use |
|---|---|
| `.card` | One group of data in the side column. It has an `h3` title. Use `h4` for a label and `pre` for text of the Framework. |
| `.card.titled` | A card whose `h3` also holds a `.badge` with the state of the data, for example the order or the courier booking. |
| `details.card` | Reference data that the operator does not watch, for example the Permission Policy. It stays closed. Write the number of items in the summary. |
| `.chips` | A row of small buttons that fill an editor, for example suggested prompts. A chip does not send a request. |
| `.editor` | A `textarea` for code or JSON. |
| `.row` | A primary button with its related controls. Each group has at most one `button.primary`. |
| `.badge`, `.dot` | A status word, and a status colour in the navigation. |
| `.note` | A limit that the operator must know before a run. Only the reason why a scenario cannot run shows open in the title bar. |
| `details.notes` | The closed notes of the title bar. Its summary gives the number of notes and prerequisites. When it is open, a grid holds the `.note` items and the Prerequisites card side by side. |
| `.fine`, `.muted` | A small explanation, and an empty state. |
| `.error`, `.outcome` | A failure, and the result of an action. |
| `.thread-events` | A closed event list for one Thread in a scenario that compares Threads. |
| `.tool.compacted` | The Compaction card of the conversation: the summary and the first kept event. |
| `.tool.child` | The card of one child Thread in the conversation. Its `.items` hold the task, the Tool calls and the answer of the child, from the stream of the child. |
| `.tool.script` | The card of one `run_script` call in the conversation. Its `.items` hold the Tool calls of the Script and their results. |
| `.you`, `.agent`, `.tool` | The items of the conversation. One `.tool` card holds the input, the Approval and the result of one Tool call. A `continue` Approval uses the same card for the budget of the Turn. |

An empty list shows a `.muted` sentence that tells what fills it. Do not show an empty card.

## States

- Set a button to `disabled` while its request runs. Set it back in a `finally` block.
- The `sync` function owns the **Run** button, the Turn controls, the status line and the typing indicator. Change the `busy`, `waiting` and `parked` values, then call `sync`. Do not set them from a second place.
- A scenario with `upload` gets a `.row` with the file input, **Attach the sample file** and **Remove the file**. A sent message clears the file.
- A scenario that compares Threads or Scopes gets a `select` next to **Run**. It selects the Thread that the conversation shows and that receives each Turn. The `TARGETS` function of the scenario gives the options, and the `syncTarget` function owns them. An option with a Scope sets the `scope` query parameter of each Thread route. The `threadRoute` function builds the route.
- A scenario with `controls` gets **Add to this Turn**, **Queue for the next Turn** and **Cancel the Turn** in the `.row` of **Run**. These buttons work only while a Turn runs or is parked.
- The Compaction and recovery scenario gets a **Ledger system** card with **Hold the ledger** and **Release the ledger**, and a **Context of the Agent** card with **Compact the Thread**. A panel action keeps the Thread of the conversation. Only a saved Agent Spec starts a new one.
- The Delegation scenario gets a **Child Threads** card and a **Usage records** card. A `delegation.started` event adds a `.tool.child` card and opens a stream of the child Thread. The `childStreams` set holds each one, and `closeStreams` closes them with the stream of the page. An Approval of a child shows in the parent conversation with the label of the child, and its answer goes to the parent route.
- The Memory scenario gets a **Memory** card for each sample Scope, with **Start a new Thread** and **Forget the User**. Its **Scope boundary** card shows the raw answer of a Thread route in a `pre`. A closed card shows the Profile fields. A new Thread moves the composer to it when the conversation is in that Scope.
- The Usage and logging scenario gets a **Usage records** card, a **UsageHandler** card and a **Logs** card.
- **Fail the next batch** and **Deliver the last batch again** act on the sample UsageHandler. **Deliver the last batch again** shows only after the handler stored a batch. Each delivery is one line: its key in `code` and its status in a `.badge`.
- **Show redaction** writes `redactFields` of a sample object. A closed card shows the `parent` shape of a Delegation child.
- The **Usage records** card shows the fields that each record of the Thread shares in `rows`, with the sum of the reported costs. A `.table` then has one row for each record: its `seq`, its tokens, its cost and the source of the cost. A record without a cost says **Not reported**.
- The Queue delivers Usage records after the Turn, and no Thread event tells the page. While the scenario state has `handler.waiting`, the **UsageHandler** card shows a `waiting for the Queue` badge, and the `awaitQueue` function reads the state again every 2 seconds, for at most one minute.
- The **Logs** card shows each log line as an `h4` with the level and the message, and a `pre` with the fields.
- The isolate Scripts scenario gets an **Order system** card, a **Script runs** card and a closed card with the Script grant and the Permission Policy. A `tool.call` or `tool.result` event with a `parentCallId` goes in the `.items` of the `run_script` card that it names, not in a card of its own. The `scripts` map holds these lists by the `seq` of the `run_script` call.
- The **Script runs** card shows one item for each Script: its call id in `code`, its state in a `.badge`, the value in a `pre` or the error in a `pre.error`, the explanation in an `.outcome`, the logs and the nested calls with their `parentCallId`.
- The container Scripts scenario gets a **Script runs** card, a **Sample files** card, a **Network allow-list** card and a closed card with the Script grant. The **Script runs** card shows one item for each Script: its language and call id, its state in a `.badge`, the input files, the Job progress, the exit code, stdout, stderr in a `pre.error`, the explanation in an `.outcome` and the artifacts. The `mediaList` function renders a list of media refs with a download link, for this scenario and the media scenario. A `job.progress` or `job.cancelled` event reads the state again. A container `run_script` card in the conversation lists no nested Tool calls, because a container Script has no Tools.
- The Scope lifecycle scenario gets a **Disposable Scope** card with the Destroy walk, a **Scope credential** card, a **Credential of each model Step** card, a **Provider profile of the Scope** card and a **Key ring** card. Its state names the Scope in `scopeId`, and each Thread route of the page uses it. The credential field has the type `password`, and the page never shows a stored value. While the Destroy walk runs, the `watchProgress` function reads the state each second.
- The MCP scenario gets a **Remote MCP server** card, a **Tools of the server** card, a **Static credential** card or a **Connection of the User** card, and a closed card with the Permission Policy. The server card is a form until a server is registered. The `mcpForm` object keeps what the operator typed, but never the header value, which has the type `password`. **Connect** opens the consent page in the same tab, and the callback sends the browser back with `connected` in the query. The `oauthReturn` value shows that outcome one time. A `connect` Approval goes in the card of its Tool call with **Open the consent page**, which opens a new tab, and **Deny**. Only OAuth can allow it.
- The Provider scenario gets an **Agent Spec** card with the profile `select`, the `web_search` grant and its Policy rule, a **Model Steps** card, a **Tool calls** card, a **Usage records** card and a closed card with the Provider profiles. The `providerForm` object keeps the settings that the operator did not save. A save keeps the Thread. The conversation names the profile of a model Step when it changes, and a `server_tool.called` event gets a **Provider Tool call** card.
- The Knowledge scenario gets a **Corpus** card for each corpus, with **Delete** on each document and **Destroy the corpus**. The **Passages of a search** card shows the Passages of the Retriever in a `pre`. The **Ingest a document** card is a form with chips, and the `ingestForm` object keeps what the operator typed. The **Bulk ingest Job** card shows the progress of the Job, and the `watchProgress` function reads the state on a timer while the Job is pending.
- The vector retrieval scenario gets a **Passages of a search** card with a mode `select` and the Passages of each sample Scope, a **Vectorize index** card with **Rebuild the index**, **Remove the vectors from the index** and **Read the index again**, and closed cards with the opaque vector ids and the guides. Without Workers AI and Vectorize, its state has `missing`, and one card tells it.
- The Schedules scenario gets a **Subscriber of this page** card. **Detach the Subscriber** closes the socket of the page. The page then reads new events and the scenario state on a timer. The `setAttached` function owns this state. The socket connects again after one second. The `listen` function does nothing when the operator opened a different view in that time.
- The `add` function appends to the conversation. It scrolls only when the operator is at the end.
- A card gets the `changed` class when its data changes. The operator then sees the effect of a Tool call.
- Check `mine === view` after each `await` in a render function. The operator can open a different view during the request.
- The `onEvent` function skips an event with a `seq` that the page has, because a stream that connects again after a restart of the dev server can repeat one.
- Handle a new Thread event in the `switch` of `onEvent`. Show it as an item of the conversation, not as raw JSON. The event log has the raw JSON.

## Layout and sizes

- At 1100 px and less, the navigation becomes a drawer.
- Above 760 px, the conversation and the side column fill the height of the view, and each one scrolls by itself. The conversation gets two thirds of the width.
- At 760 px and less, the zones stack in one column and a table becomes a list. The conversation has a fixed height of 65 % of the view.
- Each grid column uses `minmax(0, …)`, and each flex child that holds text has `min-width: 0`. Long text then wraps.
- Do not give an element a fixed width in `px`. Use `rem`, `fr` or a percentage.
- A button on a phone is at least 40 CSS pixels high. The mobile media query sets this value.
- Use the variables of `:root` for each colour. Use `light-dark()` when you add a variable.
- Keep an animation below 200 ms. The `prefers-reduced-motion` rule stops each animation.

## Text

The text of the page follows [`docs/agents/writing.md`](../../../docs/agents/writing.md). Write each term as `CONTEXT.md` writes it. Name a button with a verb.

## Checks

Run `pnpm test:browser`. It includes the layout test for the three sizes. A new scenario needs no change to that test, because the test reads the scenarios from the navigation.

To look at the page, add a temporary file in `browser/` that calls `page.setViewportSize` and `page.screenshot` for 1440, 820 and 390 px. Use `page.emulateMedia({ colorScheme: "dark" })` for the dark colours. Delete the file before you commit.
