---
"@karmi/core": minor
"@karmi/http": minor
---

Changed code-defined Agents. A Scope now runs the current code definition. Before, the first Turn in a Scope stored a copy, and the Scope kept that copy after a change to the code.

- The code definition is version 0. `step.started` and `thread.status()` report `agentVersion: 0` for it.
- A Spec that `scope.agents.put` stores with the id of a code-defined Agent is an Override. The Scope runs the Override until you delete it.
- `scope.agents.get` returns the code definition when the Scope has no Override. `get(agentId, { version: 0 })` always returns it.
- `scope.agents.list` shows each code-defined Agent. `AgentSummary.updatedAt` and `AgentRecord.createdAt` are now optional, because the code definition has neither.
- `scope.agents.delete` of an Override makes the code definition apply again. For a code-defined Agent without an Override, it throws `agent.codeDefined`, which `@karmi/http` answers with a 409.
- `put({ ifVersion })` now compares with the version that `get` reports. A deleted Agent reports 0.
- The validation of a Spec now also checks the Memory profiles of the code-defined Agents.

A Scope that ran a code-defined Agent before this release has a stored copy, which is now an Override. To use the code definition again, delete the copy.

Before:

```text
await scope.agents.put(refundAgent.spec);
```

After:

```text
await scope.agents.delete("refund");
```
