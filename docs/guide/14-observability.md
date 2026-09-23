---
title: Observability
---

# Observability

karmi gives you two records of what a Deployment does. Usage records tell what each Step spent. Log lines tell what your code reported.

The event log of a Thread is the trace of each Turn. karmi has no OpenTelemetry export. [Threads](04-threads.md#read-events) tells how to read the events.

A Provider failure ends with `turn.failed { reason: "provider" }`. Its message includes the final error code and message. It includes the HTTP status when the Provider supplies one. karmi redacts credentials and excludes the Provider's raw error body.

## Usage records

A Usage record is a `usage.recorded` Thread event. The Harness writes it in the same write as the Step that it accounts for. A record has one of three kinds:

| `kind`       | Source                          |
| ------------ | ------------------------------- |
| `model`      | One model call of a Step.       |
| `compaction` | The model call of a compaction. |
| `script`     | One Script run in the Sandbox.  |

Each record has these attribution fields:

| Field      | Description                                                     |
| ---------- | --------------------------------------------------------------- |
| `scope`    | The Scope.                                                      |
| `agent`    | The Agent.                                                      |
| `user`     | The User. A user-less Thread has none.                          |
| `threadId` | The Thread.                                                     |
| `parent`   | The Thread that delegated the work, when the Thread is a child. |
| `turn`     | The Turn.                                                       |
| `seq`      | The position of the record in the event log.                    |

A Thread that does delegated work records its own spend. Thus no tokens occur in two records.

A `model` or `compaction` record also has these fields:

| Field                                   | Description                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `input`, `output`                       | The token counts. `output` includes `reasoning`.                              |
| `cacheRead`, `cacheWrite`               | The cache token counts.                                                       |
| `cacheWrite1h`                          | The part of `cacheWrite` with one-hour retention. Only Anthropic gives it.    |
| `reasoning`                             | The reasoning tokens, when the Provider reports them.                         |
| `serverToolCalls`                       | The number of Provider Tool calls.                                            |
| `model`                                 | The model id of the Provider, without the profile prefix.                     |
| `provider`                              | The adapter that served the call.                                             |
| `profile`                               | The Provider profile of the call, after a fallback.                           |
| `credentialSource`, `credentialVersion` | The source and the version of the credential, if the profile has one.         |
| `fallback`                              | `{ from, reason }` when the call fell back from a different profile.          |
| `cost`                                  | The cost that a gateway reported.                                             |
| `gateway`                               | `{ provider: "cloudflare", id }`, the log entry of the Cloudflare AI Gateway. |

A `script` record has `tier`, `wallMs` and `callId`. `tier` is `isolate` or `container`. `wallMs` is the run time in milliseconds.

`thread.status().usage` gives the sum of the tokens of the Thread.

### Cost

karmi has no price table. A record has `cost` only when OpenRouter or the Vercel AI Gateway reported a cost in the response.

| Field      | Description                                                          |
| ---------- | -------------------------------------------------------------------- |
| `amount`   | The cost.                                                            |
| `currency` | Always `"USD"`.                                                      |
| `source`   | `"openrouter"` or `"vercel-gateway"`.                                |
| `basis`    | `"billed"`, `"list"` or `"estimate"`.                                |
| `upstream` | The charge of the upstream provider, when the gateway reports it.    |
| `byok`     | `true` when the call used your own provider key through the gateway. |

[Providers](05-providers.md) describes the gateways.

## Receive Usage records

A UsageHandler receives Usage records in batches through `KARMI_QUEUE`. Define it with `defineUsageHandler` and list it as `usageHandler` in the Catalogue. This sample sends each record to a billing service:

```ts
import { createKarmi, defineAgent, defineUsageHandler, usageKey } from "@karmi/core";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

const billing = defineUsageHandler({
  async onUsage(records) {
    for (const record of records) {
      await fetch("https://billing.example.com/usage", {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": usageKey(record) },
        body: JSON.stringify(record),
      });
    }
  },
});

const karmi = createKarmi({ catalogue: { agents: [supportAgent], usageHandler: billing } });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export default { queue: karmi.queueHandler };
```

- The Queue delivers each batch at least once. `usageKey(record)` returns `threadId:seq`, which is the same for a record that arrives two times. Use it as the idempotency key.
- When `onUsage` throws, the Queue sends the batch again. The Turn does not fail.
- With no UsageHandler, the records stay in the event log of each Thread.
- A UsageHandler with no `KARMI_QUEUE` binding is an error at start.
- Your Worker must export `karmi.queueHandler` as `queue`.

## Logging

Tools, Hooks and Retrievers log through `ctx.logger`. [Tools](03-tools.md) shows a Tool that logs. A Logger has the methods `debug`, `info`, `warn` and `error`. Each method takes a message and optional fields.

karmi adds the Scope, the Agent, the User, the Thread and the Turn to each line. The default Logger is `consoleLogger()`. It writes one JSON line for each call to the Worker console, where Workers Observability indexes each field.

Pass `logger` to `createKarmi` to send the lines to a different place. This sample keeps the console output and sends errors to a log service:

```ts
import { consoleLogger, createKarmi, defineAgent, type Logger } from "@karmi/core";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

const base = consoleLogger();

const logger: Logger = {
  debug: (message, fields) => base.debug(message, fields),
  info: (message, fields) => base.info(message, fields),
  warn: (message, fields) => base.warn(message, fields),
  error(message, fields) {
    base.error(message, fields);
    void fetch("https://logs.example.com/errors", { method: "POST", body: JSON.stringify({ message, ...fields }) });
  },
};

export const karmi = createKarmi({ catalogue: { agents: [supportAgent] }, logger });
```

### Redaction

karmi redacts each line before the line gets to a Logger. It replaces these values with a marker:

- A Sensitive value.
- A field with a name such as `token`, `secret`, `password`, `authorization`, `apiKey` or `cookie`.
- A bearer token in text.

`redactFields(fields)` applies the same redaction to an object of your own. `bindLogger(base, fields)` returns a Logger that adds `fields` to each line and redacts the result. This sample makes a Logger for a cron handler:

```ts
import { bindLogger, consoleLogger } from "@karmi/core";

const cronLogger = bindLogger(consoleLogger(), { job: "nightly-report" });

cronLogger.info("The report started", { authorization: "Bearer abc123" });
```

The line has `job` and a marker in the place of the `authorization` value.
