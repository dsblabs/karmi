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
| Title bar | `.intro` | The title, the status, the summary, notes, the link to the example code and **Reset scenario** |
| Conversation | `#steps` | What the operator and the Agent did, in the sequence of the Thread events |
| Composer | `.composer` | The prompt, the suggested prompts, **Run**, the Turn controls and the status line |
| Side column | `.side` | The state of the sample system, the controls that change the scenario and the event log |

- An action on the full scenario goes in the title bar.
- An action that sends a Turn goes in the composer.
- An action on the sample system or the Agent goes in the card that shows that data.
- The function in `PANELS` gives the cards of the side column for a scenario. The first card is the data that the scenario changes. It moves above the conversation on a phone.

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
| `.note` | A limit that the operator must know before a run. |
| `.fine`, `.muted` | A small explanation, and an empty state. |
| `.error`, `.outcome` | A failure, and the result of an action. |
| `.thread-events` | A closed event list for one Thread in a scenario that compares Threads. |
| `.tool.compacted` | The Compaction card of the conversation: the summary and the first kept event. |
| `.tool.child` | The card of one child Thread in the conversation. Its `.items` hold the task, the Tool calls and the answer of the child, from the stream of the child. |
| `.you`, `.agent`, `.tool` | The items of the conversation. One `.tool` card holds the input, the Approval and the result of one Tool call. A `continue` Approval uses the same card for the budget of the Turn. |

An empty list shows a `.muted` sentence that tells what fills it. Do not show an empty card.

## States

- Set a button to `disabled` while its request runs. Set it back in a `finally` block.
- The `sync` function owns the **Run** button, the Turn controls, the status line and the typing indicator. Change the `busy`, `waiting` and `parked` values, then call `sync`. Do not set them from a second place.
- A scenario with `upload` gets a `.row` with the file input, **Attach the sample file** and **Remove the file**. A sent message clears the file.
- A scenario that compares Threads or Scopes gets a `select` next to **Run**. It selects the Thread that the conversation shows and that receives each Turn. The `TARGETS` function of the scenario gives the options, and the `syncTarget` function owns them. An option with a Scope sets the `scope` query parameter of each Thread route. The `threadRoute` function builds the route.
- A scenario with `controls` gets a second `.row` in the composer: **Add to this Turn**, **Queue for the next Turn** and **Cancel the Turn**. These buttons work only while a Turn runs or is parked.
- The Compaction and recovery scenario gets a **Ledger system** card with **Hold the ledger** and **Release the ledger**, and a **Context of the Agent** card with **Compact the Thread**. A panel action keeps the Thread of the conversation. Only a saved Agent Spec starts a new one.
- The Delegation scenario gets a **Child Threads** card and a **Usage records** card. A `delegation.started` event adds a `.tool.child` card and opens a stream of the child Thread. The `childStreams` set holds each one, and `closeStreams` closes them with the stream of the page. An Approval of a child shows in the parent conversation with the label of the child, and its answer goes to the parent route.
- The Memory scenario gets a **Memory** card for each sample Scope, with **Start a new Thread** and **Forget the User**. Its **Scope boundary** card shows the raw answer of a Thread route in a `pre`. A closed card shows the Profile fields. A new Thread moves the composer to it when the conversation is in that Scope.
- The Usage and logging scenario gets a **Usage records** card, a **UsageHandler** card and a **Logs** card.
- **Fail the next batch** and **Deliver the last batch again** act on the sample UsageHandler. **Deliver the last batch again** shows only after the handler stored a batch. Each delivery is one line: its key in `code` and its status in a `.badge`.
- **Show redaction** writes `redactFields` of a sample object. A closed card shows the `parent` shape of a Delegation child.
- Each Usage record shows its key, its model, its tokens and a cost line. The cost line is the reported cost, or that the Provider reported none.
- The **Logs** card shows each log line as an `h4` with the level and the message, and a `pre` with the fields.
- The Schedules scenario gets a **Subscriber of this page** card. **Detach the Subscriber** closes the socket of the page. The page then reads new events and the scenario state on a timer. The `setAttached` function owns this state. The socket connects again after one second. The `listen` function does nothing when the operator opened a different view in that time.
- The `add` function appends to the conversation. It scrolls only when the operator is at the end.
- A card gets the `changed` class when its data changes. The operator then sees the effect of a Tool call.
- Check `mine === view` after each `await` in a render function. The operator can open a different view during the request.
- The `onEvent` function skips an event with a `seq` that the page has, because a stream that connects again after a restart of the dev server can repeat one.
- Handle a new Thread event in the `switch` of `onEvent`. Show it as an item of the conversation, not as raw JSON. The event log has the raw JSON.

## Layout and sizes

- At 1100 px and less, the navigation becomes a drawer.
- At 760 px and less, the zones stack in one column and a table becomes a list.
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
