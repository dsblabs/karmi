---
title: Testing
---

# Testing

The Test kit is the `@karmi/core/testing` entry. It runs your Catalogue in workerd against a scripted Provider. A test needs no Provider credential and makes no request to a model.

A project from `create-karmi` has this setup already. [Getting started](01-getting-started.md#run-the-tests) tells how to run the suite.

## The test Worker

Tests run under `@cloudflare/vitest-plugin`, which starts a Worker from `test/wrangler.jsonc`. That file has the same bindings as your `wrangler.jsonc`, and its `main` is `test/worker.ts`.

`createTestKarmi(catalogue, options?)` takes the Catalogue under test. The options are the `createKarmi` options without `catalogue` and `clock`. This sample is a full `test/worker.ts`:

```ts
import { defineAgent } from "@karmi/core";
import { createTestKarmi } from "@karmi/core/testing";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

export const { karmi, provider, scope, clock, secrets } = createTestKarmi({ agents: [supportAgent] });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;

export default { queue: karmi.queueHandler };
```

| Field      | Description                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `karmi`    | The Deployment under test.                                                |
| `provider` | The scripted Provider. Its name is `fake`, and it serves each model id.   |
| `scope`    | The Scope `test`. The `send` of its Threads waits for the Turn.           |
| `clock`    | The Clock of the Deployment. `clock.advance` moves it.                    |
| `secrets`  | The in-memory Secrets provider, unless you pass `secrets` in the options. |

In your `src/worker.ts`, export the Catalogue apart from `createKarmi`. Then the test Worker can import the same Catalogue.

## Script the Provider

`provider.script(replies)` sets the replies and clears `provider.requests`. Each list item answers one model call. A string is a text reply. A nested list is a reply with more than one part.

`send` on a test Thread resolves when the Turn completes, fails or parks. It returns the events of that Turn. `lastMessage(events)` returns the final text of the Agent. This sample scripts one Tool call and checks the answer:

```ts
import { lastMessage, reply } from "@karmi/core/testing";
import { expect, it } from "vitest";
import { provider, scope } from "./worker";

it("answers after a Tool call", async () => {
  provider.script([[reply.toolCall("searchOrders", { customer: "alice" })], "You have one open order."]);
  const thread = scope.thread({ agent: "support", user: "alice", threadId: "order-help" });
  const events = await thread.send({ kind: "message", parts: [{ type: "text", text: "Where is my order?" }] });
  expect(lastMessage(events)).toBe("You have one open order.");
  expect(provider.requests).toHaveLength(2);
});
```

The `reply` helpers build the parts of a reply:

| Helper                             | Part                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `reply.text(...chunks)`            | Text. The Provider streams one delta for each chunk. |
| `reply.reasoning(...chunks)`       | Reasoning text.                                      |
| `reply.toolCall(name, input, id?)` | A Tool call. The default id is `call_<block index>`. |
| `reply.usage(usage)`               | Token counts for the call.                           |
| `reply.error({ code })`            | A Provider error that ends the stream.               |
| `reply.stop(stopReason)`           | A stop reason that replaces the default.             |
| `reply.raw(raw)`                   | A raw Provider payload.                              |

`provider.script` also takes a function of `{ request, index, options }`. `index` is the number of the call, from 0. Use a function when the reply depends on the request.

`provider.requests` has each request that the Harness sent, in order. Use it to check the messages and the Tools that the model gets.

## Event matchers

`matchers` has two vitest matchers for a list of Thread events. `toContainEvent` passes when one event has the given type and fields. `toHaveSequence` passes when the event types occur in the given order. Other events can occur between them.

This setup file registers the matchers. List it in `setupFiles` of your vitest configuration:

```ts
import { matchers } from "@karmi/core/testing";
import { expect } from "vitest";

expect.extend(matchers);
```

This declaration file, `test/matchers.d.ts` in the template, gives the matchers their types:

```ts
import type { ThreadEventType } from "@karmi/core";
import type { EventPartial } from "@karmi/core/testing";

declare module "vitest" {
  interface Assertion<T> {
    toContainEvent(partial: EventPartial): T;
    toHaveSequence(types: ThreadEventType[]): T;
  }
}
```

This sample checks the events of one Turn:

```ts
import { reply } from "@karmi/core/testing";
import { expect, it } from "vitest";
import { provider, scope } from "./worker";

it("logs the Tool result", async () => {
  provider.script([[reply.toolCall("searchOrders", { customer: "alice" })], "You have one open order."]);
  const thread = scope.thread({ agent: "support", user: "alice", threadId: "order-events" });
  const events = await thread.send({ kind: "message", parts: [{ type: "text", text: "Where is my order?" }] });
  expect(events).toContainEvent({ type: "tool.result", name: "searchOrders" });
  expect(events).toHaveSequence(["turn.started", "tool.result", "turn.completed"]);
});
```

## Time

`clock.advance(duration)` moves the Clock forward. `duration` is a number of milliseconds or a string such as `"24h"`. It then fires each Durable Object alarm of the test Worker that is due. Use it to test [Schedules](08-schedules.md) and Approval timeouts. This sample moves the Clock forward by one day:

```ts
import { it } from "vitest";
import { clock } from "./worker";

it("fires the alarms of the next day", async () => {
  await clock.advance("24h");
});
```

## Record and replay a real Provider

`recordingProvider(real)` wraps a real Provider and keeps each request with the events of its answer. `toJSONL()` returns the recording as JSON Lines. This sample registers a recording Provider:

```ts
import { createKarmi, defineAgent } from "@karmi/core";
import { anthropic } from "@karmi/anthropic";
import { recordingProvider } from "@karmi/core/testing";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

export const recorder = recordingProvider(anthropic());

export const karmi = createKarmi({
  catalogue: { agents: [supportAgent] },
  providers: { anthropic: recorder },
});
```

Store the output of `recorder.toJSONL()` in a file. `fakeProvider.fromRecording(jsonl)` makes a scripted Provider that serves the entries in call order. This sample replays a recording:

```ts
import { fakeProvider } from "@karmi/core/testing";

export function replay(jsonl: string) {
  return fakeProvider.fromRecording(jsonl);
}
```

Give the same `key` function to the two functions to match entries by request and not by call order. `key` takes the request and returns a string.

## A Provider of your own in a test

`fakeProvider(script, options?)` makes a scripted Provider that you register as any other Provider. Use it when `createTestKarmi` does not fit, for example to test a fallback between two Provider profiles. [Providers](05-providers.md) describes profiles. This sample registers a scripted Provider:

```ts
import { createKarmi, defineAgent } from "@karmi/core";
import { fakeProvider } from "@karmi/core/testing";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "fake/support-model" },
});

export const provider = fakeProvider(["Your order is on its way."]);

export const karmi = createKarmi({
  catalogue: { agents: [supportAgent] },
  providers: { fake: provider },
  defaults: { providers: { default: { adapter: "fake", models: ["*"] } } },
});
```

## Other doubles

- `fakeMcpServer` is an in-process MCP server. Pass it in `createTestKarmi(catalogue, { mcpServers })`. [MCP](11-mcp.md) describes MCP servers.
- `memorySecrets` is the in-memory Secrets provider. [Credentials](12-credentials.md) describes Secrets providers.

## HTTP routes

To test the routes of `@karmi/http`, mount `createHttpHandler` in the test Worker with the `karmi` from `createTestKarmi`. Then send requests with `SELF.fetch` from `cloudflare:test`. [HTTP](06-http.md) describes the routes. This sample is the `fetch` handler of such a test Worker:

```ts
import { createHttpHandler } from "@karmi/http";
import type { Karmi } from "@karmi/core";

export function testFetch(karmi: Karmi) {
  return createHttpHandler({
    karmi,
    authenticate: (request) =>
      request.headers.get("authorization") === "Bearer test-token" ? { scope: "test", user: "alice" } : null,
  });
}
```

## Doctor checks in a test

The checks of `karmi doctor` are functions, and a test can run them against the real Catalogue. [Doctor](15-doctor.md#run-the-checks-in-a-test) shows the test.
