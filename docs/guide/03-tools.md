---
title: Tools
---

# Tools

A Tool is a function that the model can call. The Harness validates the input, applies the Permission Policy and then runs the function.

## Define a Tool

`defineTool` makes a Tool for the Catalogue. It throws a `KarmiError` when the name is not valid. This sample defines a Tool that reads one order:

```ts
import { defineTool } from "@karmi/core";
import { z } from "zod";

export const getOrder = defineTool({
  name: "get_order",
  description: "Reads one order by its id",
  input: z.object({ orderId: z.string().describe("The id of the order") }),
  annotations: { readOnlyHint: true },
  async execute({ orderId }, ctx) {
    ctx.logger.info("Reading an order", { orderId });
    const response = await fetch(`https://orders.example.com/orders/${orderId}`, { signal: ctx.signal });
    return response.ok
      ? await response.text()
      : { content: [{ type: "text", text: "Order not found." }], isError: true };
  },
});
```

| Field          | Description                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `name`         | The name that an Agent Spec uses to refer to the Tool.                          |
| `description`  | The text that the model reads to decide when to call the Tool.                  |
| `input`        | The schema of the input. The Harness validates each call before `execute` runs. |
| `annotations`  | Hints for the Permission Policy and for parallel calls.                         |
| `settings`     | The schema of the `settings` that an Agent Spec can give for this Tool.         |
| `requires`     | The name of the Connection that the Tool uses.                                  |
| `instructions` | A Fragment that the Harness adds to the Prompt when the Tool is available.      |
| `output`       | A lower limit for the size of the output of this Tool.                          |
| `execute`      | The function that runs one call.                                                |

### Results

`execute` returns one of these values:

- A string. The model gets the string as text.
- A result object `{ content, isError?, structuredContent? }`. This is the MCP result shape.
- `{ pending: jobId }`. The Step parks until a Job reports the result. See [Threads](./04-threads.md).

`errorResult(text)` makes a result object with `isError: true`.

### Context

The second argument of `execute` is the Tool context. It has these fields:

| Field        | Description                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `scope`      | The Scope of the Thread.                                                                        |
| `user`       | The User of the Thread. A user-less Thread has no `user`.                                       |
| `thread`     | A reference to the Thread.                                                                      |
| `settings`   | The `settings` from the Agent Spec, validated against the schema of the Tool.                   |
| `connection` | The Connection, when the Tool has `requires` and a Connection resolved.                         |
| `callId`     | The id of this call. It does not change when the Step runs again. Use it as an idempotency key. |
| `attempt`    | The recovery attempt of the Step. The first attempt is 1.                                       |
| `media`      | Stores bytes under the Thread and returns a media ref.                                          |
| `logger`     | A Logger that adds the Scope, Agent, User, Thread and Turn to each line.                        |
| `signal`     | An `AbortSignal`. The Harness aborts it when the call must stop.                                |

## Annotations

Annotations are the MCP tool hints. The Permission Policy can match them. The Harness also uses them to decide which calls can run again after an interruption.

| Hint              | Default | Meaning                                            |
| ----------------- | ------- | -------------------------------------------------- |
| `readOnlyHint`    | `false` | The Tool changes nothing.                          |
| `destructiveHint` | `true`  | The Tool can delete or overwrite data.             |
| `idempotentHint`  | `false` | A second call with the same input changes nothing. |
| `openWorldHint`   | `false` | The Tool reads or writes systems outside your own. |

After an interruption, the Harness runs an unfinished call again only when `readOnlyHint` or `idempotentHint` is true. Each other unfinished call gets an error result.

## Tool references in an Agent Spec

An Agent Spec lists its Tools by name. A reference can also be an object with `settings` and `alwaysLoad`. This sample gives settings to one Tool and prevents its deferral:

```ts
import { defineAgent } from "@karmi/core";

export const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["get_order", { name: "search_orders", settings: { region: "eu" }, alwaysLoad: true }],
});
```

## Provider Tools

A Provider Tool runs at the model provider, not in your Worker. The names are `web_search` and `web_fetch`. Grant them with the `providerTools` Capability. This sample grants both, with call limits:

```ts
import { defineAgent } from "@karmi/core";

export const researchAgent = defineAgent({
  agentId: "research",
  name: "Research",
  instructions: [{ text: "Find sources on the web and cite them." }],
  model: { id: "anthropic/claude-sonnet-5" },
  capabilities: {
    providerTools: {
      tools: ["web_search", "web_fetch"],
      limits: { maxCallsPerTurn: 4, maxCallsPerThread: 20 },
    },
  },
});
```

- The Anthropic Provider supports both names. The AI SDK Provider supports `web_search` for `openai/*` models only.
- A Permission Policy rule can `allow` or `deny` a Provider Tool. `ask` is not valid. A grant with no matching rule allows the Tool.
- `before-tool` Hooks do not run for a Provider Tool. `after-tool` Hooks see the result and cannot change it.
- Each call adds a `server_tool.called` event and a `server_tool.result` event to the Thread.
- When the calls reach a limit, the Harness removes the Provider Tool from the next request.

A Provider profile can set the version of a Provider Tool in `providerOptions.anthropic.serverTools` or `providerOptions.openai.serverTools`. A version setting does not grant the Tool.

## Skills

A Skill is a set of instructions and Tools that enters the context only after activation. The model always sees the `description` of each Skill. This sample defines a Skill with one Tool:

```ts
import { defineSkill, defineTool } from "@karmi/core";
import { z } from "zod";

const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refunds one order",
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => `Refunded order ${orderId}.`,
});

export const refunds = defineSkill({
  name: "refunds",
  description: "How to handle a refund request",
  body: () => "Check the order date first. Refund only orders from the last 30 days.",
  tools: [issueRefund],
});
```

Put the Skill in `catalogue.skills` and its name in the `skills` list of the Agent Spec.

Two things can activate a Skill:

- The model calls the built-in `use_skill`.
- A User command names the Skill on the Turn input, for example `send({ kind: "message", parts, skill: "refunds" })`.

`invokableBy` is `model`, `user` or `both`. The default is `both`. A reference in an Agent Spec can make it narrower. The model cannot see or call the Tools of a Skill that is not active. Activation adds a `tools.loaded` event to the Thread.

## Deferred Tools

When an Agent has many Tools, the Harness can defer their definitions. The model then sees only the names. It loads a definition with the `tool_search` built-in.

`context.tools.defer` in the Agent Spec controls this:

- `auto` is the default. All deferrable Tools defer when their definitions use more than `threshold` of the context window. The default `threshold` is `0.1`.
- `always` defers all deferrable Tools.
- `never` defers no Tools.

Framework built-ins, Skill Tools and references with `alwaysLoad: true` do not defer.

`tool_search` accepts `select:a,b` for exact names, or keywords. A keyword search loads a maximum of five Tools. Loaded Tools stay loaded in later Turns. A Compaction that removes the load event from the context also unloads the Tools. A call to a Tool that is not loaded returns an error result and runs nothing.

The Permission Policy applies before deferral. The index does not list a denied Tool. A Policy that denies `tool_search` while deferral is on fails validation.

Next, read [Threads](./04-threads.md).
