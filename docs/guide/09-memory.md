---
title: Memory
---

# Memory

Memory is what the Agents of a Scope remember about one User. It continues between Threads. Each Agent with a `memory` block in its Spec shares one Memory for each pair of Scope and User.

A Memory has two parts:

- The Profile holds fields with a schema, for example the tier of a customer.
- The Notes are short free texts. A Note has at most 2,000 characters.

Memory lives in its own Durable Object. The Worker must bind `KARMI_MEMORY` to `MemoryDO`. The project from [Getting started](./01-getting-started.md) has this binding.

## Give an Agent a Memory

This sample gives an Agent one Profile field and Notes:

```ts
import { defineAgent } from "@karmi/core";

export const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Help the customer with their orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
  memory: {
    profile: {
      properties: {
        tier: { type: "string", enum: ["silver", "gold"], description: "The loyalty tier of the customer." },
      },
    },
  },
});
```

`memory.profile` is a JSON Schema object. The Profile of a Scope holds the fields of all its Agents. If two Agents give one field different types, `scope.agents.put` fails with `memory.profile.conflict`.

Set `memory.notes` to `false` for a Memory with no Notes.

## What the model sees

The model gets a Memory Fragment after the Skill index. The Fragment shows the Profile and the 20 most recent Notes. The Harness reads the Memory one time, at the start of each Turn.

Two built-in Tools write and search the Memory:

| Tool                           | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `remember { profile?, note? }` | Merges the Profile fields and adds a Note.                                |
| `recall { query }`             | Searches the Notes with full-text search and returns the 10 best matches. |

- An Agent can write only the fields that its own schema declares. The Harness checks each value against that schema and keeps all other fields.
- The value `null` clears a field.
- `recall` finds a Note that `remember` added earlier in the same Turn.
- With `memory.notes: false`, the model does not get `recall`, and `remember` takes only `profile`.

The Permission Policy allows the two Tools by default. A policy rule that names one of them applies to it.

A user-less Thread has no Memory. The Fragment is empty, and the two Tools return an error result. A Delegation child acts for the User of its parent. Thus it reads and writes the same Memory.

## Read and delete a Memory

`scope.users.memory` reads and deletes Memory from your code. Only a Turn writes it. This sample returns the Profile of a User and the five most recent Notes:

```ts
import type { Karmi, MemoryView } from "@karmi/core";

export async function customerMemory(karmi: Karmi, user: string): Promise<MemoryView> {
  return karmi.scope("acme").users.memory.get(user, { notes: 5 });
}
```

| Method                  | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `get(user, { notes? })` | Returns `{ profile, notes }`, the most recent Note first. The default is 100 Notes. |
| `list()`                | Returns each User that has a stored Memory in the Scope.                            |
| `delete(user)`          | Deletes the Profile and the Notes of the User, and removes the User from `list()`.  |

Use `delete` when a User asks you to erase their data.
