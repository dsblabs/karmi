---
title: Doctor
---

# Doctor

`karmi doctor` checks a project before `wrangler deploy` does. It reads `wrangler.jsonc` and the Worker entry, and it finds configuration that stops a Deployment. The command is in `@karmi/core`.

## Run the command

Run this command in the project directory:

```sh
pnpm exec karmi doctor
```

The command prints one line for each finding. This is a sample of the output:

```text
ok   compatibility: compatibility_date 2026-08-04 is at or above 2026-08-04.
ok   bindings: Every karmi binding is declared under its fixed name.
ok   durable-objects: Every bound Durable Object class is exported and migrated as SQLite.
--   capabilities: No KARMI_LOADER binding: an Agent granting capabilities.scripts { tier: "isolate" } fails.
warn mcp: Set createKarmi({ oauth: { origin } }); no OAuth server can be used without it.
```

| Mark   | Status | Meaning                                        |
| ------ | ------ | ---------------------------------------------- |
| `ok`   | `pass` | The check found no problem.                    |
| `warn` | `warn` | A feature does not work, but the deploy works. |
| `FAIL` | `fail` | The deploy or the Worker fails.                |
| `--`   | `skip` | The check had no input.                        |

The command exits with code 1 when a finding has the status `fail`. It also exits with code 1 when it cannot read a file or an option is incorrect. Warnings and skipped checks exit with code 0.

The template of `create-karmi` runs `karmi doctor` before `vitest run` in `pnpm test`. [Getting started](01-getting-started.md#run-the-tests) describes that step.

## Options

| Option              | Default                                 | Description                                                   |
| ------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `--config <path>`   | `wrangler.jsonc`                        | The wrangler configuration to check.                          |
| `--manifest <path>` | `karmi.doctor.json`, if the file exists | The JSON file that tells what the Deployment defines in code. |
| `--binding <name>`  | `KARMI_VECTORIZE`                       | The Vectorize binding to check.                               |
| `--dims <n>`        | `1024`                                  | The embedding dimensions that the index must have.            |
| `--metric <name>`   | `cosine`                                | The metric: `cosine`, `euclidean` or `dot-product`.           |
| `--help`            |                                         | Prints the options.                                           |

The command reads the Worker entry from the `main` field, relative to the configuration file. If it cannot read the entry, it skips the check of the Durable Object exports.

## Checks

The checks run in this order:

| Check             | Input                        | Findings                                                                                             |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compatibility`   | `wrangler.jsonc`             | A `compatibility_date` below the floor of karmi fails. No `global_fetch_strictly_public` flag warns. |
| `bindings`        | `wrangler.jsonc`             | A Durable Object binding that is not there fails. See the list of warnings below.                    |
| `durable-objects` | `wrangler.jsonc` and `main`  | A bound class that the entry does not export, or that has no SQLite migration, fails.                |
| `capabilities`    | `wrangler.jsonc`             | Tells if the `isolate` and `container` Script tiers are available. It never fails.                   |
| `vectorize`       | The Vectorize management API | An index with incorrect dimensions, metric or metadata indexes fails.                                |
| `gateway`         | The manifest file            | A Provider profile behind an AI Gateway while an Agent defers its Tools warns.                       |
| `mcp`             | The manifest file            | Lists each MCP server for which you must register an OAuth client by hand.                           |
| `specs`           | The manifest file            | An Agent Spec with an incorrect shape, or with a name that the Catalogue does not define, fails.     |

The `bindings` check gives a warning for each of these conditions:

- A binding has a `KARMI_` name that karmi does not use, for example a spelling error.
- A Queue has a producer and no consumer.
- `KARMI_MEDIA` has no R2 bucket.

The `vectorize` check runs only when the configuration has the Vectorize binding. It also needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment. [Knowledge](10-knowledge.md) describes the index.

The `mcp` check also gives a warning when an OAuth server is there and the manifest file has no `origin`. [MCP](11-mcp.md) describes OAuth for MCP servers.

## The manifest file

The last three checks need data that a wrangler configuration does not have. Write that data as JSON in `karmi.doctor.json`, or pass a different path with `--manifest`. The file can have comments. This sample shows the four fields:

```jsonc
{
  // The value of createKarmi({ oauth: { origin } }).
  "origin": "https://agents.example.com",
  // The value of createKarmi({ defaults }).
  "defaults": {
    "providers": { "default": { "adapter": "anthropic", "gateway": { "kind": "cloudflare" } } },
  },
  // The result of karmi.catalogue.describe().
  "catalogue": { "tools": [{ "name": "searchOrders" }] },
  // Each Agent Spec, with its source as the key.
  "specs": {
    "agents/support.json": {
      "agentId": "support",
      "name": "Support",
      "instructions": [],
      "tools": ["searchOrders"],
      "model": { "id": "anthropic/claude-sonnet-5" },
    },
  },
}
```

Each field is optional. The checks read only these parts:

- From `catalogue`, the names of the Tools, Fragments, Skills, Retrievers and Hooks, and the `agentId` of each Agent.
- From `defaults`, the `gateway` of each Provider profile and the `url` and `auth` of each MCP server.

A check with no input reports `--` and does not fail. If `--manifest` names a file that is not there, the command fails.

## Run the checks in a test

Each check is also a function. A test has the real Catalogue and the real Agent Specs in memory. Thus a test can run the three manifest checks with no `karmi.doctor.json` to keep up to date. The template of `create-karmi` has such a test.

| Function                       | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `decodeWranglerConfig(source)` | Reads the text of a wrangler configuration. It throws `config.invalid`. |
| `decodeDoctorManifest(value)`  | Reads a manifest object. It throws `config.invalid`.                    |
| `runChecks(input)`             | Runs each check and returns the findings. It reads no files.            |
| `formatFindings(findings)`     | Returns the lines that the command prints.                              |
| `hasFailure(findings)`         | Returns `true` when a finding has the status `fail`.                    |

`runChecks` takes these fields:

| Field              | Description                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `config`           | The result of `decodeWranglerConfig`. This field is mandatory.                            |
| `entry`            | The source text of the Worker entry.                                                      |
| `manifest`         | The result of `decodeDoctorManifest`.                                                     |
| `cloudflare`       | `{ accountId, apiToken }` for the `vectorize` check.                                      |
| `index`            | `{ dims, metric }` that the index must have. The default is 1024 and `cosine`.            |
| `vectorizeBinding` | The Vectorize binding. The default is `KARMI_VECTORIZE`.                                  |
| `fetch`            | The `fetch` function for the Vectorize management API. The default is the global `fetch`. |

A finding is `{ check, status, message }`. This sample runs the checks against the Catalogue and one Agent:

```ts
import {
  decodeDoctorManifest,
  decodeWranglerConfig,
  hasFailure,
  runChecks,
  type Agent,
  type Finding,
  type Karmi,
} from "@karmi/core";

export async function checkProject(karmi: Karmi, supportAgent: Agent, wranglerJsonc: string): Promise<Finding[]> {
  const findings = await runChecks({
    config: decodeWranglerConfig(wranglerJsonc),
    manifest: decodeDoctorManifest({
      origin: "https://agents.example.com",
      catalogue: karmi.catalogue.describe(),
      specs: { "src/catalogue.ts": supportAgent.spec },
      defaults: { providers: { default: { adapter: "anthropic" } } },
    }),
  });
  if (hasFailure(findings)) throw new Error("karmi doctor found a failure.");
  return findings;
}
```

In a vitest test, import the configuration as text with `import config from "../wrangler.jsonc?raw"`. [Testing](13-testing.md) describes the test Worker.
