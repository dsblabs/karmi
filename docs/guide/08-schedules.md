---
title: Schedules
---

# Schedules

A Schedule sends an Event to a Thread at a later time. The Thread starts a Turn for it. Your code can make a Schedule, and an Agent can make one for its own Thread.

## Make a Schedule

`thread.schedule` takes an Event and one timing. It returns `{ scheduleId, nextAt }`. This sample sends an `invoice.overdue` Event in three days:

```ts
import type { Karmi } from "@karmi/core";

export async function remindLater(karmi: Karmi, invoice: string): Promise<string> {
  const thread = karmi.scope("acme").thread({ agent: "billing", user: "alice", threadId: "dunning" });
  const { scheduleId } = await thread.schedule({
    delay: "3d",
    input: { kind: "event", type: "invoice.overdue", payload: { invoice } },
  });
  return scheduleId;
}
```

Give one of these timings, and only one:

| Timing  | Value                                                     | Example                                        |
| ------- | --------------------------------------------------------- | ---------------------------------------------- |
| `delay` | A number of milliseconds or a duration text.              | `{ delay: "24h" }`                             |
| `at`    | A time in epoch milliseconds or an ISO 8601 text.         | `{ at: "2026-10-01T09:00:00+02:00" }`          |
| `cron`  | A cron expression with five fields. `tz` is an IANA zone. | `{ cron: "0 9 * * 1-5", tz: "Europe/Berlin" }` |

The default `tz` is UTC. `input` is an Event with the same shape that `send` takes. [Threads](./04-threads.md) describes Turn inputs.

If you open the Thread by identity, `schedule` creates the Thread when it does not exist.

## List and cancel Schedules

This sample cancels each pending Schedule of a Thread:

```ts
import type { Thread } from "@karmi/core";

export async function cancelAll(thread: Thread): Promise<number> {
  const pending = await thread.schedules();
  for (const { scheduleId } of pending) await thread.cancelSchedule(scheduleId);
  return pending.length;
}
```

- `thread.schedules()` returns the pending Schedules, the soonest first. Each one has `scheduleId`, `nextAt`, `createdAt`, `input`, and `at` or `cron` with `tz`.
- `thread.cancelSchedule(scheduleId)` rejects with `schedule.notFound` when the Thread has no such Schedule.
- `thread.status()` gives the time of the soonest Schedule as `nextScheduleAt`.

## When a Schedule fires

A Schedule that fires does the same as `send` with the Event. Thus the Event joins the queue while a Turn runs or is parked.

- A Schedule with `delay` or `at` fires one time. Then the Thread deletes it.
- An `at` in the past fires immediately.
- The Thread does not try a failed Turn again.
- A cron Schedule keeps at most one Event that the Thread did not start yet. If the next tick comes before that, the Thread records `schedule.skipped` and waits for the subsequent tick.
- The Thread calculates the next cron tick from the time that the Schedule fired. It does not send the ticks that it missed.

The Thread records `schedule.created`, `schedule.fired`, `schedule.skipped` and `schedule.cancelled` events. A Thread holds at most 100 pending Schedules. No Schedule can be more than one year in the future. The constant `SCHEDULE_CAPS` contains the two limits.

## Let an Agent make Schedules

The `scheduling` Capability gives an Agent three built-in Tools: `schedule`, `cancel_schedule` and `list_schedules`. They work on the Thread of the Agent and on no other Thread. This sample grants the Capability with limits:

```ts
import { defineAgent } from "@karmi/core";

export const billingAgent = defineAgent({
  agentId: "billing",
  name: "Billing",
  instructions: [{ text: "Remind the customer about each overdue invoice." }],
  model: { id: "anthropic/claude-sonnet-5" },
  capabilities: {
    scheduling: { maxPending: 5, maxHorizonMs: 30 * 24 * 60 * 60 * 1000, cron: false },
  },
});
```

- `maxPending` is the number of pending Schedules that the Agent can hold.
- `maxHorizonMs` is the longest time into the future.
- `cron` controls cron Schedules.

The Scope ceiling and the limits of the Thread can lower these values.

The Agent gets a fired Schedule as the Event `{ kind: "event", type: "schedule.fired", payload }`. A Permission Policy rule that names `schedule` can give `ask`.

## Triggers from other systems

A trigger from another system is your code. A Worker `scheduled` or `queue` handler finds the Thread and sends an Event. karmi does not remove an Event that arrives two times.

This sample sends a daily Event from a Worker cron to a user-less Thread:

```ts
import type { Karmi } from "@karmi/core";

export async function dailyReport(karmi: Karmi, controller: ScheduledController): Promise<void> {
  await karmi
    .scope("acme")
    .thread({ agent: "reporter", threadId: "daily-report" })
    .send({
      kind: "event",
      type: "report.daily",
      payload: { cron: controller.cron, at: controller.scheduledTime },
    });
}
```

This sample sends one Event for each Queue message and then acknowledges the message:

```ts
import type { Karmi } from "@karmi/core";

interface OrderPlaced {
  scope: string;
  user: string;
  order: string;
}

export async function handleOrders(karmi: Karmi, batch: MessageBatch<OrderPlaced>): Promise<void> {
  for (const message of batch.messages) {
    const { scope, user, order } = message.body;
    await karmi
      .scope(scope)
      .thread({ agent: "orders", user, threadId: `order-${order}` })
      .send({ kind: "event", type: "order.placed", payload: { order } });
    message.ack();
  }
}
```

Call these functions from the `scheduled` and `queue` handlers of your Worker. The project from [Getting started](./01-getting-started.md) has the two handlers in `src/triggers.ts`. The cron expression of a Worker cron goes in `triggers.crons` of `wrangler.jsonc`.
