---
title: Providers
---

# Providers

A Provider is an adapter that connects karmi to a model API. You register each Provider by name in `createKarmi`. A Provider profile selects a Provider and tells how to reach the API.

## Provider profiles

A profile is in `defaults.providers` of `createKarmi` or in the config of a Scope. Each Scope inherits the defaults and can only make them tighter. A profile holds no secrets.

| Field             | Description                                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| `adapter`         | The name of a Provider in `createKarmi({ providers })`.                              |
| `models`          | The model id patterns that the profile can serve. The default is `<adapter>/*`.      |
| `credential`      | A credential reference, `scope:<name>` or `deployment:<name>`.                       |
| `baseUrl`         | The endpoint of a self-hosted or OpenAI-compatible API. A gateway overrides it.      |
| `gateway`         | The AI Gateway configuration.                                                        |
| `compaction`      | `harness` (the default) or `provider`. It selects who writes the Compaction summary. |
| `providerOptions` | Options for the adapter. karmi sends them with no change.                            |
| `headers`         | Headers that are not secret. karmi sends them on each request.                       |
| `fallback`        | A Deployment profile to use when the credential is missing or rejected.              |

An Agent Spec uses the profile that `model.providerProfile` names. Without that field, it uses the profile named `default`.

A credential is always a reference, never a value. `scope:<name>` is a credential that the Scope stores. `deployment:<name>` is a credential from `createKarmi({ credentials })`. Topic page 12 describes credentials in full.

## Anthropic

`@karmi/anthropic` is the Anthropic Provider. It uses the Messages API. This sample registers it with a credential of the Deployment:

```ts
import { anthropic } from "@karmi/anthropic";
import { createKarmi, defineAgent } from "@karmi/core";
import { env } from "cloudflare:workers";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
});

export const karmi = createKarmi({
  catalogue: { agents: [supportAgent] },
  providers: { anthropic: anthropic() },
  credentials: { anthropic: env.ANTHROPIC_API_KEY },
  defaults: {
    providers: { default: { adapter: "anthropic", credential: "deployment:anthropic" } },
  },
});
```

`anthropic({ apiKey })` sets a Provider credential for profiles that name no credential.

`providerOptions.anthropic` accepts `thinking`, `effort`, `fallbacks`, `contextManagement`, `taskBudget`, `mcpServers`, `cache` and `betas`. The Provider adds the beta flag that each feature needs.

A profile with `compaction: "provider"` makes the Anthropic API write the Compaction summary.

The Provider sends images and PDF files as base64 blocks. When the model cannot take a file, or the file is too large or missing, the Provider sends a text placeholder.

Each request uses the `fetch` that karmi gives to the Provider. Thus the egress policy of the Scope applies to each request.

## A Provider credential for each Scope

A tenant can use its own Provider credential. Store it in the Scope and name it in the Scope config. This sample stores the credential, sets the profile and tests it:

```ts
import type { Karmi } from "@karmi/core";

export async function useTenantKey(karmi: Karmi, tenant: string, apiKey: string): Promise<void> {
  const scope = karmi.scope(tenant);
  await scope.credentials.put("anthropic", apiKey);
  await scope.config.set({
    providers: {
      default: {
        adapter: "anthropic",
        credential: "scope:anthropic",
        fallback: { profile: "shared", on: ["missing", "auth"] },
      },
    },
  });
  await scope.providers.test("default", { model: "anthropic/claude-sonnet-5" });
}
```

- `credentials.put` is write-only. No API returns the value.
- The `fallback` names a profile in the `defaults` of the Deployment. The default value of `on` is `["missing"]`.
- `scope.providers.test` makes one small call to the model API. It is the only check that uses the network.
- A revoked credential stops at the next Step, also in the middle of a Turn.

## AI SDK

`@karmi/ai-sdk` is a Provider for each model package of the AI SDK. Install the model packages that you use. `aiSdk` takes a factory that returns a model. This sample registers OpenAI models:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { aiSdk } from "@karmi/ai-sdk";

export const openai = aiSdk(({ modelId, fetch, credentials }) => {
  const apiKey = credentials?.provider?.expose();
  if (!apiKey) throw new Error("The profile has no credential.");
  return createOpenAI({ apiKey, fetch })(modelId);
});
```

Register it as `createKarmi({ providers: { openai } })` and add a profile with `adapter: "openai"`.

The factory runs for each call. It gets these values:

- `modelId` and `config`, which is the resolved profile.
- `fetch`, which applies the egress policy of the Scope. Give it to the client.
- `signal` and a `logger`.
- `credentials`, which holds the `credential` and `gateway.credential` of the profile.

Each credential is a `SensitiveValue`. Call `expose()` to give the value to the client. Do not keep the value after the call.

The same factory works with `createGoogleGenerativeAI`, `createAnthropic`, `createOpenAICompatible`, `createGateway` and `createWorkersAI`. For OpenRouter, use `createOpenRouter` from `@openrouter/ai-sdk-provider`. That package keeps the cost that OpenRouter reports.

`providerOptions: { aiSdk: { openai: { store: false } } }` gives options to the SDK provider. The `params.reasoning` of the Agent Spec maps to the reasoning option of each provider.

## Cloudflare AI Gateway

### With the Anthropic Provider

Add a `gateway` to the profile. No code change is necessary. This sample sends Anthropic requests through a gateway with a stored provider key:

```ts
import type { Karmi } from "@karmi/core";

export async function useGateway(karmi: Karmi, tenant: string, accountId: string): Promise<void> {
  await karmi.scope(tenant).config.set({
    providers: {
      default: {
        adapter: "anthropic",
        gateway: { kind: "cloudflare", accountId, gatewayId: "support", credential: "deployment:gateway", byok: true },
      },
    },
  });
}
```

- The `credential` of the gateway is the gateway token. The Provider sends it as `cf-aig-authorization`.
- With `byok: true`, the gateway holds the Anthropic key. The Worker sends no provider key.
- The Provider adds the Scope, Agent, Thread and Turn as gateway metadata.
- Cloudflare AI Gateway reports no cost in the response. Each usage record has the `cf-aig-log-id`, so that you can join it with the gateway log.

### With the AI SDK Provider

Use `ai-gateway-provider` with its `binding` configuration. Its key mode uses the global `fetch` and thus does not apply the egress policy of the Scope. This sample sends each gateway request through the `fetch` of the factory:

```ts
import { aiSdk } from "@karmi/ai-sdk";
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { env } from "cloudflare:workers";

export const openaiViaGateway = aiSdk(({ modelId, fetch, signal, credentials }) => {
  const gateway = createAiGateway({
    binding: {
      run: (data: unknown) =>
        fetch(env.AI_GATEWAY_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-aig-authorization": `Bearer ${credentials?.gateway?.expose()}`,
          },
          body: JSON.stringify(data),
          signal,
        }),
    },
  });
  const apiKey = credentials?.provider?.expose();
  if (!apiKey) throw new Error("The profile has no credential.");
  return gateway(createOpenAI({ apiKey }).chat(modelId));
});
```

karmi does not estimate a cost for Cloudflare AI Gateway.

Next, read [HTTP](./06-http.md).
