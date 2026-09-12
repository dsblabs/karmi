# @karmi/ai-sdk

A karmi Provider over AI SDK `LanguageModelV4.doStream()`. karmi owns the loop.
Install the model packages you use; they are optional peers.

```ts
import { aiSdk } from "@karmi/ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const provider = aiSdk(async ({ modelId, config, fetch }) => {
  const apiKey = await resolveCredential(config.credential);
  return createOpenAI({ apiKey, fetch, baseURL: config.baseUrl })(modelId);
});
// createKarmi({ providers: { openai: provider }, ... })
```

The factory runs for each call and receives `modelId`, the resolved `config`,
`fetch` (the Scope's scopedFetch), `signal`, attribution and logger. Construct the
client there so credentials and transport belong to that call. Credential
resolution belongs to your factory; references are never treated as API keys.

The same factory works with `createGoogleGenerativeAI`, `createAnthropic`,
`createOpenAICompatible`, `createGateway` and `createWorkersAI`. For OpenRouter,
use `createOpenRouter` from `@openrouter/ai-sdk-provider`, which retains reported
cost; the generic OpenAI-compatible provider does not supply that contract.
Workers AI accepts either its native binding or REST settings with `fetch`.

`providerOptions: { aiSdk: { openai: { store: false } } }` is the escape hatch.
The adapter validates namespaced JSON; the selected SDK provider validates its
own options. `params.reasoning` uses V4's provider-specific reasoning mapping
(`off` becomes `none`), with a native reasoning mapping for OpenRouter v3.
Explicit native provider options retain SDK precedence.
Tool choice and strict function schemas are forwarded.

Text, reasoning, compaction and tool calls retain `providerMetadata` on the
persisted block and replay it as AI SDK `providerOptions`. Core strips model-specific
metadata on a model change; compaction and provider-tool metadata survives while
the provider stays the same. Provider-executed calls/results remain `server_tool`
blocks; fallback iterations remain opaque provider blocks. Raw chunks and finish
metadata remain observable as `raw` events. Only a finish part records usage and
reported cost; truncated or failed streams emit one terminal error.

Capabilities start at `unknown` (optimistic). After a call, positive media URL
support from the model is cached; absence from `supportedUrls` does not prove
that inline media is unsupported. Until the media pipeline materialises refs,
attachments become descriptive placeholders, matching the native adapter.

## Cloudflare AI Gateway

`ai-gateway-provider` 4's API-key mode uses global fetch internally. Use its
binding configuration to keep gateway HTTP traffic on scopedFetch:

```ts
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";

const provider = aiSdk(({ modelId, fetch, signal }) => {
  const gateway = createAiGateway({
    binding: {
      run: (data) => fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-aig-authorization": `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify(data),
        signal,
      }),
    },
  });
  return gateway(createOpenAI({ apiKey: providerKey }).chat(modelId));
});
```

Resolve gateway URL, headers and tokens from the profile in your factory.
With `config.gateway` set, `cf-aig-log-id` is recorded for asynchronous cost joins.
Cloudflare cost is never estimated. Vercel gateway cost is parsed with `Number()`;
OpenRouter cost and upstream/BYOK fields come from finish usage. Missing or
invalid cost stays absent, including BYOK when the provider does not report it.

Tests run in workerd with real model packages and deterministic SSE fixtures,
plus V4 stream fixtures for replay, error and cost edge cases. They make no live
provider requests.

Media refs become V4 inline file parts at request-build, including Tool-result content. Missing media and non-viewable files become text placeholders; unknown model capabilities send optimistically. Generated files and nested Tool/MCP images are stored through the call's `media.put` before emitting refs. Generated file URLs are fetched through the call's scoped transport before storage.
