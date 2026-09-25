---
title: Agents
---

# Agents

An Agent is a set of instructions, a model and the things that the model can use. You describe an Agent with an Agent Spec. An Agent Spec is plain JSON.

## Define an Agent

`defineAgent` makes an Agent Spec in code. Put the result in the Catalogue of `createKarmi`. This sample defines one Agent that can call one Tool:

```ts
import { createKarmi, defineAgent, defineTool } from "@karmi/core";
import { z } from "zod";

const searchOrders = defineTool({
  name: "search_orders",
  description: "Finds the orders of a customer",
  input: z.object({ email: z.string() }),
  annotations: { readOnlyHint: true },
  execute: ({ email }) => `No orders found for ${email}.`,
});

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  description: "Answers questions about orders",
  instructions: [{ text: "Answer questions about orders. Be brief." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["search_orders"],
  policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
});

export const karmi = createKarmi({ catalogue: { tools: [searchOrders], agents: [supportAgent] } });
```

An Agent Spec refers to Tools, Skills and other Catalogue items by name. The `agentId` can contain letters, digits, underscores and hyphens. Its maximum length is 64 characters.

## Instructions

`instructions` is a list of entries. The Harness puts the entries in the Prompt in the order that you give. An entry is one of these:

- `{ text }` is literal text.
- `{ fragment, args }` is the name of a Fragment in the Catalogue, with its arguments.

An entry can have a `models` field. The field holds one model pattern or a list of patterns, for example `"anthropic/*"`. The Harness then uses the entry only for a model that matches.

## Model

The `model` field selects the model and its parameters.

| Field             | Description                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `id`              | The model in the form `provider/model`, for example `anthropic/claude-sonnet-5`. |
| `providerProfile` | The name of the Provider profile to use. See [Providers](./05-providers.md).     |
| `fallbacks`       | Model ids that the Harness uses when the first model is not available.           |
| `params`          | `temperature`, `topP`, `maxOutputTokens` and `reasoning`.                        |
| `providerOptions` | Options that go to the Provider with no change.                                  |

`params.reasoning` is `off`, `low`, `medium` or `high`.

## Permission Policy

`policy` is a list of rules. Each rule has a `match` and an `effect`. The `match` selects Tools by name or by annotations. The `effect` is `allow`, `ask` or `deny`.

The Harness tries the rules in order, and the first match decides. If no rule matches, the call waits for an Approval. [Threads](./04-threads.md) tells how to answer an Approval.

## Other fields

| Field          | Description                                                               | Page                                       |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `skills`       | The Skills that the Agent can activate.                                   | [Tools](./03-tools.md)                     |
| `capabilities` | Grants for Scripts, long Turns, Delegation, Schedules and Provider Tools. | [Tools](./03-tools.md) and the topic pages |
| `context`      | The context window, the Compaction limits and Tool deferral.              | [Threads](./04-threads.md)                 |
| `approvals`    | `timeout` is the time in milliseconds before an Approval becomes a deny.  | [Threads](./04-threads.md)                 |
| `knowledge`    | The Knowledge that the Agent can search.                                  | Topic page 10                              |
| `memory`       | The Memory Profile fields and Notes of the Agent.                         | Topic page 09                              |
| `delegates`    | The Agents that this Agent can delegate work to.                          |                                            |
| `hooks`        | The names of Hooks for each Hook point.                                   |                                            |
| `connections`  | The Connections that the Tools of the Agent use.                          |                                            |

## Agent Specs as data

A Platform can store an Agent Spec for a Scope at runtime. No deploy is necessary. `scope.agents.put` validates the Spec and stores it as the next version. This sample stores a Spec that the Platform holds as JSON:

```ts
import type { AgentSpec, Karmi } from "@karmi/core";

export async function saveAgent(karmi: Karmi, tenant: string, spec: AgentSpec): Promise<number> {
  const { version } = await karmi.scope(tenant).agents.put(spec);
  return version;
}
```

`scope.agents` also has `get`, `list`, `history`, `delete` and `validate`. `put` accepts `{ ifVersion }`, which stores the Spec only when `get` reports that version. `ifVersion: 0` stores the Spec only when the Scope has no stored version in use.

`delete` tombstones the Agent. Its versions stay readable by number, and the next `put` continues the numbers. Thus a version number in the log of a Thread always names one Spec.

## Code-defined Agents and Overrides

A Scope runs the current code definition of each code-defined Agent. After a deploy, the next Turn in each Scope uses the new code. The Scope stores nothing for the Agent. The code definition has version 0, and `step.started` reports `agentVersion: 0`.

A Spec that `put` stores with the `agentId` of a code-defined Agent is an Override. The Scope then runs the Override. A change to the code does not reach that Scope. This sample stores the code definition of `supportAgent` with other instructions, for one tenant:

```ts
import { defineAgent, type Karmi } from "@karmi/core";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

export async function overrideSupport(karmi: Karmi, tenant: string, instructions: string): Promise<void> {
  const spec = { ...supportAgent.spec, instructions: [{ text: instructions }] };
  await karmi.scope(tenant).agents.put(spec, { ifVersion: 0 });
}
```

For a code-defined Agent, the operations of `scope.agents` do these things:

- `get(agentId)` returns the Override. Without an Override, it returns the code definition as version 0.
- `get(agentId, { version: 0 })` always returns the code definition.
- `list()` shows each code-defined Agent. An Agent without an Override shows version 0 and no `updatedAt`.
- `history(agentId)` lists only the versions of the Overrides.
- `delete(agentId)` removes the Override, and the code definition applies again. Without an Override, it throws `agent.codeDefined`. To remove a code-defined Agent, remove it from the Catalogue.

To keep one Scope on the current code definition after a later deploy, store that definition as an Override.

The Framework checks the code definition against the Catalogue at boot. A Turn does not check it against the Scope. The Turn applies the ceilings of the Scope to it, in the same way as to a stored Spec. `put` and `validate` check a Spec against all the Agents of the Scope, the code-defined Agents included.

`validateAgentSpec` checks a Spec against the Catalogue with no Scope. Use it in an editor or in a test. This sample returns the messages of the issues that block a Spec:

```ts
import { validateAgentSpec, type Karmi } from "@karmi/core";

export function specErrors(karmi: Karmi, json: unknown): string[] {
  const result = validateAgentSpec(json, karmi.catalogue);
  if (result.ok) return [];
  return result.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.path}: ${issue.message}`);
}
```

When `ok` is true, the result has the `normalized` Spec and a list of `warnings`. When `ok` is false, the result has the `issues`. Each issue has a `severity`, a `code`, a `path` and a `message`. Only an issue with the severity `error` makes `ok` false. `agentSpecJsonSchema` is the JSON Schema of an Agent Spec. Give it to an editor to check a Spec while the user types.

Next, read [Tools](./03-tools.md).
