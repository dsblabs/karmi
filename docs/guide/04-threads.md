---
title: Threads
---

# Threads

A Thread is one conversation with one Agent. It lives in its own Durable Object. Its only state is an event log, and each client reads the same events.

## Open a Thread and send a Turn

`karmi.scope(id).thread(identity)` returns a handle. The identity is the Agent, the User and a `threadId`. The first `send` creates the Thread. This sample sends one message and reads the events:

```ts
import type { Karmi, ThreadEvent } from "@karmi/core";

export async function ask(karmi: Karmi, question: string): Promise<ThreadEvent[]> {
  const thread = karmi.scope("acme").thread({ agent: "support", user: "alice", threadId: "order-help" });
  const { seq } = await thread.send({ kind: "message", parts: [{ type: "text", text: question }] });
  return thread.events({ after: seq });
}
```

A Thread with no `user` is a user-less Thread. Use one for work that an Event starts, for example a cron.

`thread.key` is an opaque string that you can store. `scope.thread(key)` opens the same Thread again. A handle from a key does not create a Thread.

A Turn input is a message or an Event:

- `{ kind: "message", parts, skill?, channelRef? }` is a User message. A Part is text or a media ref.
- `{ kind: "event", type, payload, channelRef? }` is an Event from your system.

`send` returns `{ turn, seq }` when the Thread accepts the input. It does not wait for the Turn to end.

## Read events

| Method                                     | Description                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `thread.events({ after })`                 | Returns the stored events after `after`. It does not wait.             |
| `thread.subscribe({ after, granularity })` | Streams live events as an async iterable.                              |
| `thread.socket({ after, granularity })`    | Returns a WebSocket upgrade response. Return it from your Worker.      |
| `thread.status()`                          | Returns the current Turn, the budget, the pending Approvals and usage. |

`subscribe` and `socket` stream live events by default. Give `after` to get the stored events first. `after: 0` gives the full log. `granularity` is `delta`, `part` or `turn`. The default is `delta`, which includes each streaming chunk.

Each event has a `seq`, a `turn` and a time `at`. A client that stores the last `seq` can connect again with `after` and lose no events.

## Inputs during a Turn

While a Turn runs or is parked, each new `send` joins a queue. The Harness puts the queued inputs into one next Turn, in order.

`send(input, { steer: true })` adds the input to the Turn that runs now. The model sees it after the current batch of Tool calls.

`thread.cancel()` stops the Turn with `turn.failed { reason: "cancelled" }`. It answers the pending Approvals as denied. Queued inputs still run. Cancellation cannot undo a change that a Tool made in another system.

## Parking

A parked Turn waits and uses no Worker time. A Turn parks for an Approval, for its budget or for a Job.

### Approvals

When the Permission Policy gives `ask`, the Harness first runs the allowed calls of the batch. Then it adds one `approval.requested` event for each asked call and parks the Turn. This sample allows the first pending Approval:

```ts
import type { Thread } from "@karmi/core";

export async function allowFirst(thread: Thread, reviewer: string): Promise<void> {
  const { pendingApprovals } = await thread.status();
  const first = pendingApprovals?.[0];
  if (first) await thread.approve(first.seq, { decision: "allow", by: reviewer });
}
```

- A `deny` becomes an error result that the model sees next. You can give a `reason`.
- `remember: true` allows that Tool by name for the rest of the Thread.
- The Thread rejects a second answer to the same Approval.
- An Approval with no answer becomes a deny after `approvals.timeout`. The default is 24 hours.

### Budget

Each Turn has a budget of Steps, wall time and tokens. The `longRunning` Capability sets `{ maxSteps, maxWallMs, maxTokens }`. Without the grant, the Turn gets small defaults.

When the Turn uses all of its budget, it parks with `approval.requested { kind: "continue" }`. An allow gives a new budget. A deny or a timeout ends the Turn with `stopReason: "budget"`.

### Jobs

A Tool can return `{ pending: jobId }` to give its call to a Job. A Job is work that runs outside the Turn, for example in a Queue consumer. The Step parks until your code reports the result. This sample reports a result:

```ts
import type { Karmi } from "@karmi/core";

export async function finishExport(karmi: Karmi, threadKey: string, jobId: string, url: string): Promise<void> {
  const thread = karmi.scope("acme").thread(threadKey);
  await thread.jobs.complete(jobId, { content: [{ type: "text", text: `The export is at ${url}.` }] });
}
```

`thread.jobs` also has `progress`, `fail` and `cancel`.

## Compaction

Compaction keeps a long Thread inside the context window of the model. Before each model Step, the Harness compares the context size with `context.window - reserveTokens`. If the context is larger, a `compact` Step runs:

1. The Harness keeps the most recent events, approximately `keepRecentTokens`. The cut is never inside a batch of Tool calls and results.
2. It makes a summary of the events before the cut.
3. It adds a `thread.compacted` event.

The Harness does not change the log. The next request contains the Prompt, the summary and the events after the cut.

| `context` field    | Default                                            |
| ------------------ | -------------------------------------------------- |
| `window`           | The value that the Provider reports for the model. |
| `reserveTokens`    | 16,384                                             |
| `keepRecentTokens` | 20,000                                             |

The Harness writes the summary with its own model call. A Provider profile with `compaction: "provider"` makes the provider write it. See [Providers](./05-providers.md).

`thread.compact({ instructions })` compacts an idle Thread on request. A `before-compact` Hook can return `{ skip: true }` or its own `{ summary }`. An `after-compact` Hook sees the result.

## Fork a Thread

`thread.fork(seq, { threadId })` makes a new Thread for the same Agent and User. The new Thread has the log up to `seq`. The Harness copies the media of that log into the fork. Thus the fork keeps its media after you delete the first Thread. If the copy fails, `fork` rejects and makes no Thread.

## Delete a Thread

`thread.delete()` marks the Thread as deleted immediately and stops new work. The Harness then removes the media and the events in batches. Only a deletion marker stays. The marker prevents a second use of the same Thread identity.

## Offline delivery

A Deliverer sends the output of a Thread to a Channel when no client is connected. Examples of a Channel are email and a chat app. Define a Deliverer, put it in the Catalogue and name it on a Turn input. This sample defines a Deliverer that posts each completed Turn to a webhook:

```ts
import { defineDeliverer } from "@karmi/core";

export const webhook = defineDeliverer({
  name: "webhook",
  granularity: "turn",
  async deliver(threadKey, events, ref) {
    await fetch("https://hooks.example.com/karmi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadKey, events, ref }),
    });
  },
});
```

This sample sends an Event and sets the Deliverer of the Thread:

```ts
import type { Karmi } from "@karmi/core";

export async function paymentReceived(karmi: Karmi, payer: string, amount: number): Promise<void> {
  const thread = karmi.scope("acme").thread({ agent: "billing", user: payer, threadId: "receipts" });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: { amount },
    channelRef: { deliverer: { name: "webhook", ref: { customer: payer } } },
  });
}
```

- The Thread keeps the last `channelRef.deliverer`. An input without one uses the same Deliverer.
- The Harness delivers at the end of a Turn and at an Approval request.
- A connected socket, `subscribe()` stream or SSE stream stops offline delivery. The Harness waits one second before delivery, so that a client can connect again.
- `granularity` is `part` by default. `delta` includes streaming chunks.
- Delivery is at-least-once. Use the Thread key and the event `seq` to ignore a duplicate.
- Offline delivery needs the `KARMI_QUEUE` binding. The Worker must export `karmi.queueHandler` as its `queue` handler.

Without a Deliverer, the output stays available through `events()` and `subscribe()`.

Next, read [Providers](./05-providers.md).
