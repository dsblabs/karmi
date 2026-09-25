---
title: Sandbox
---

# Sandbox

A Script is code that the model writes and the Harness runs in a sandbox. The `scripts` Capability grants it. The grant names one of two tiers.

| Tier        | Language         | Where the Script runs                      | Tools | Network                      |
| ----------- | ---------------- | ------------------------------------------ | ----- | ---------------------------- |
| `isolate`   | JavaScript       | A new Dynamic Worker for each call         | Yes   | None                         |
| `container` | Shell and Python | A container Workspace that the Thread owns | No    | The hostnames that you allow |

With the grant, the model gets the `run_script` Tool and a usage Fragment.

## Isolate Scripts

Add the Worker Loader binding to your Wrangler configuration:

```jsonc
{
  "worker_loaders": [{ "binding": "KARMI_LOADER" }],
}
```

This sample grants isolate Scripts to an Agent and lets a Script call one Tool:

```ts
import { defineAgent } from "@karmi/core";

export const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Help the customer with their orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["searchOrders", "refundOrder"],
  capabilities: {
    scripts: {
      tier: "isolate",
      tools: ["searchOrders"],
      limits: { cpuMs: 1000, wallMs: 60000, maxToolCalls: 100 },
    },
  },
});
```

`tools` is `"allowed"` or a list of Tool names of the Agent. The default is `"allowed"`. The limits in the sample are the defaults.

The model calls `run_script({ code, description? })`. The code is a JavaScript module with a default export. This Script calls one Tool two times in parallel:

```js
export default async () => {
  const results = await Promise.all([
    tools.searchOrders({ customer: "alice" }),
    tools.searchOrders({ customer: "bob" }),
  ]);
  console.log("Searched two customers");
  return results;
};
```

### What a Script can reach

Each call runs in a new Dynamic Worker. The Worker has no network access, no filesystem, no secrets and no storage bindings.

A Script reaches only the Tools that the Permission Policy allows. It does not reach these Tools:

- A Tool that the policy denies, or for which the policy gives `ask`.
- A Provider Tool.
- `run_script`.
- A `delegate` call that parks the Turn.

Deferral and Skill activation do not change the Tools that a Script reaches. On a user-less Thread, a Script does not get the Tools that need a User. The usage Fragment names them.

Tool calls from a Script run one at a time. Each call passes through input validation and the before-tool and after-tool Hooks. A call from a Script cannot park the Turn.

A Tool call returns the `structuredContent` of the Tool if there is one. If not, it returns the text. A Tool failure throws in the Script. `__result(callId)` reads an earlier Tool result of the same Thread. A call ID has the form `{threadId}:{seq}`, where `seq` is the sequence number of the `tool.call` event.

### The result

The result of `run_script` contains these fields:

- `value`, or `error` with a `message` and an optional `stack`.
- `logs`, the console output. The Harness keeps at most 30,000 characters.
- `toolCalls`, a short summary of the Tool calls.
- `artifacts`, which is always empty in this tier.

The Tool calls and results of a Script carry a `parentCallId`. The model does not see them, and Compaction does not include them.

### Limits and failures

A Scope ceiling can lower each limit. A grant that asks for more than the ceiling fails validation. Without the `KARMI_LOADER` binding, the Script fails with `capability.unavailable`. A limit error names `cpuMs`, `wallMs` or `maxToolCalls`.

Cloudflare enforces `cpuMs` as a [resource limit](https://developers.cloudflare.com/dynamic-workers/usage/limits/), but the stop is not exact. A Script can use a few seconds of CPU time more than a small limit before Cloudflare stops it. Local workerd does not enforce `cpuMs`.

A Script runs on the same CPU thread as the Durable Object of its Thread. Thus `wallMs` and a cancel stop a Script only when the Script awaits, for example a Tool call or a timer. A Script that does not await blocks the Thread until the Script finishes or Cloudflare stops it at `cpuMs`.

Cancellation stops the Script and its Tool access when the Script awaits. It cannot undo a change that a Tool made in another system. A nested Tool call that runs at the cancel gets an interrupted result. An eviction during a Script also gives an interrupted result to each nested call that did not finish.

## Container Scripts

The container tier runs shell and Python Scripts in a container. The `@karmi/sandbox-container` package supplies the image. The image has pandas, openpyxl, pypdf, Pillow, Node, ffmpeg and jq. [Deployment](./16-deployment.md#the-container-sandbox) gives the bindings and the Worker exports for this tier.

This sample grants container Scripts that can reach one hostname:

```ts
import { defineAgent } from "@karmi/core";

export const reportAgent = defineAgent({
  agentId: "reporter",
  name: "Reporter",
  instructions: [{ text: "Build the weekly sales report." }],
  model: { id: "anthropic/claude-sonnet-5" },
  capabilities: {
    scripts: {
      tier: "container",
      limits: { wallMs: 60000, jobMaxWallMs: 600000, idleMs: 60000, maxArtifacts: 20 },
      egress: { allow: ["api.example.com"] },
    },
  },
});
```

The limits in the sample are the defaults.

| Limit          | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `wallMs`       | The time that a call waits before the process becomes a Job. |
| `jobMaxWallMs` | The total wall time of one process.                          |
| `idleMs`       | The idle time after which the Workspace stops.               |
| `maxArtifacts` | The number of files from `/out` that one call exports.       |

The model calls `run_script` with `code`, `language` and an optional `files` object. `language` is `shell` or `python`. `files` maps a plain filename to a media ref in the current Scope. A container Script gets no Tools.

### Files and the Workspace

Each Thread has one Workspace. A Delegation child has its own Workspace. Each call clears `/in` and `/out` and writes the `files` to `/in`. Other Workspace files stay until the Turn ends, the Workspace becomes idle, a cancellation occurs or you destroy the Thread.

A file in `/out` becomes an artifact in the media of the Thread. The media limits of the Scope apply. The Harness does not export a symlink.

The Scope ceiling `scripts.maxContainers` limits the number of Workspaces that the Scope has at one time. Without it, there is no limit. The Scope gets a slot back only after the Harness destroys the container. Thus a container service that is not available can hold capacity for some time.

### Long processes

A process that does not finish in `wallMs` becomes a Job, and the Turn parks. The Thread examines the process each five seconds. It adds the output as progress events, in chunks of at most 4 KB. The state of the process, not the end of its output, tells the Thread that the process is complete.

Cancellation sends SIGTERM, and then SIGKILL if the process continues. Then it destroys the Workspace. If the process no longer exists, the Script fails with `container_lost`.

### Network access

A container Script reaches only the hostnames in `egress.allow`. The default is an empty list, which allows no hostname. The Worker intercepts HTTPS and applies the list to each Script. When the Worker denies a request, the Script gets a line in stderr that names the hostname and the grant key.

Do not add a secret or a credential to the image. A Script starts with only `PATH`, `HOME` and the paths of the certificate bundle in its environment.

## Local execution

`LocalProcessSandbox` from `@karmi/sandbox-container` runs the same shell and Python Scripts as host processes, without Docker. It uses a temporary directory as the Workspace.

Use it for development Scripts that you trust, and for no other Scripts. The Script can read the files of the host, and the sandbox does not enforce `egress`. The `security` property contains this warning as text. Show it when you offer local execution.

The constructor takes a `ContainerHost`, a `ContainerLimits` and an optional list of allowed hostnames. The two types come from `@karmi/core/sandbox`. This sample makes a sandbox with the default limits:

```ts
import { containerLimits, type ContainerHost } from "@karmi/core/sandbox";
import { LocalProcessSandbox } from "@karmi/sandbox-container";

export function localSandbox(host: ContainerHost): LocalProcessSandbox {
  const limits = containerLimits({ tier: "container" }, undefined);
  return new LocalProcessSandbox(host, limits);
}
```

`run`, `poll` and `cancel` have the same inputs and results as the Cloudflare container sandbox. After a Job finishes, store its last event and then call `acknowledge()`. Until then, `poll()` returns the stored result.

- The sandbox changes a literal `/in` or `/out` path in the code to the temporary directory. It does not change a path that the code builds at run time.
- The process does not get the secrets of the host environment.
- The sandbox keeps the last 1 MB of stdout and of stderr for each process.
