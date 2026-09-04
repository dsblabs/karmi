# Cloudflare AI Gateway log join on streamed responses

Research note, 2026-09-04, for **Spike: Cloudflare AI Gateway log join via cf-aig-log-id on streamed responses**. Live calls used a private authenticated development gateway and a short-lived token with AI Gateway Run + Read. Account IDs, gateway names, tokens, log IDs, event IDs, request IDs, and stored credentials are intentionally omitted. Primary sources and the live first-party API were used.

## Decision

Keep `cf-aig-log-id` as the sole Cloudflare log join key. Capture it from the initial HTTP response before consuming the stream, persist it on `usage.recorded`, and let the Platform retry the log lookup asynchronously. A completed streamed response does **not** guarantee that `GET .../logs/{id}` already exists or already contains `cost`.

Drop `cf-aig-event-id` from the required karmi contract. It may remain an optional Cloudflare trace hint, but the current log API neither documents nor returned a queryable event-id field, and the live log detail did not retain it in the exposed request head.

Cloudflare's Anthropic route passed deferred-tool loading through successfully: a request containing `defer_loading` and the regex tool-search definition produced native `server_tool_use`, `tool_search_tool_result`, `tool_reference`, and the eventual deferred `tool_use` on the response stream.

The successful BYOK request produced an estimated `cost`. A successful Unified Billing comparison could not be run: the no-provider-key OpenAI probe returned HTTP 402 / Cloudflare error 2021, “Insufficient wholesale credits.” Its failed log eventually contained `cost: 0`; that is failure accounting, not evidence that successful Unified Billing and BYOK are costed identically.

## Raw, sanitized observations

### Stream completion to log/cost availability

All successful samples used the provider-native Anthropic route, `claude-haiku-4-5`, `stream: true`, and stored Anthropic credentials (BYOK). The uncached samples used `cf-aig-skip-cache: true` and unique prompts. Times are client-observed and rounded; they are measurements, not an SLA.

| Sample | Stream duration | First usable log/cost relative to `message_stop` | Observation |
|---|---:|---:|---|
| Initial | 6,640 ms | +1,471 ms | Two 404 / error 7002 lookups, then one complete row with non-null `cost` and token counts |
| Uncached 1 | 9,784 ms | +571 ms | Log row was visible at stream end, but `cost` became non-null later |
| Uncached 2 | 1,633 ms | <= 0 ms | Complete row with non-null `cost` on the first post-stream lookup |
| Uncached 3 | 1,985 ms | <= 0 ms | Complete row with non-null `cost` on the first post-stream lookup |
| Uncached 4 | 1,709 ms | <= 0 ms | Complete row with non-null `cost` on the first post-stream lookup |

Three accidental cached controls completed in 40–71 ms and had an immediately visible log. They are excluded from the uncached timing result because Cloudflare documents cached responses as cost zero.

The log ID was present on the initial streamed HTTP response in every successful request. The log API row contained `provider`, normalized `model`, `tokens_in`, `tokens_out`, `success`, and non-null `cost` when complete. There was no intermediate partial monetary value: `cost` was absent/null until the completed estimate appeared.

Operational conclusion: treat a 404 and a row with null `cost` as retryable states. The five successful uncached observations converged by 1.5 seconds after `message_stop`, but the implementation must use a bounded, configurable backoff rather than encode 1.5 seconds as a guarantee. Cloudflare documents the log fields but no ingestion-lag SLA [CF-logs].

### BYOK versus Unified Billing

| Path | Result | Log result |
|---|---|---|
| Anthropic provider-native route, no provider-auth header, stored default Anthropic key | HTTP 200 streamed response | Non-null estimated `cost`, input/output tokens, `success: true` |
| OpenAI provider-native route, no provider-auth header, no stored default key (Unified Billing fallback) | HTTP 402, Cloudflare error 2021, insufficient wholesale credits | Row appeared after an initial null cost and settled at `cost: 0`, zero tokens, `success: false` |

Cloudflare documents credential precedence as request key, stored `default` BYOK key, then Unified Billing [CF-UB]. The account state prevented a successful Unified Billing inference. Therefore the earlier claim that successful BYOK and Unified Billing rows populate `cost` identically remains **unverified**. Do not infer it from the failed row.

### Anthropic SDK stream helper

Tested `@anthropic-ai/sdk` 0.123.0. `client.messages.stream(...)` returns `MessageStream`; `await stream.withResponse()` returns `{ data, response, request_id, workspace_id }`, and `response.headers.get("cf-aig-log-id")` returned the gateway log ID. A counting `fetch` recorded exactly one network request while `data.finalMessage()` consumed the same stream. No lookup or second model request is necessary [SDK-stream-source].

There is a separate authentication integration trap. On this gateway, the Cloudflare documentation's SDK example (`apiKey: "placeholder"`) sent the SDK-generated `x-api-key` upstream and failed with Anthropic HTTP 401, both when gateway authentication was placed in `Authorization` (as the example shows) and when it was placed in `cf-aig-authorization`. A custom `fetch` that removed `x-api-key` and `authorization`, then set only `cf-aig-authorization`, succeeded; `withResponse()` exposed the log ID in that one request. This live result conflicts with the current Cloudflare example's statement that the placeholder is ignored [CF-Anthropic]. Karmi's direct adapter must ensure no provider-auth header is emitted when gateway-held BYOK/Unified Billing is selected.

Minimal accessor:

```ts
const stream = client.messages.stream(params);
const { data, response } = await stream.withResponse();
const logId = response.headers.get("cf-aig-log-id");
const message = await data.finalMessage();
```

### `cf-aig-event-id`

A unique `cf-aig-event-id` was sent on a successful streamed request. The subsequent log detail:

- had no event-id property in its returned object;
- did not expose the value in `request_head`;
- offered no documented event-id list filter or response field.

Cloudflare's public API schema lists `id`, cost/token fields, metadata, request/response heads, and related fields, but not event ID [CF-logs]. Cloudflare's own `gateway-core` only describes `eventId` as a request “Trace id for this event” and maps it to the header [CF-gateway-core]. This is insufficient for a Platform join. Use `cf-aig-metadata` for queryable caller dimensions and `cf-aig-log-id` for the exact row.

### Deferred tool loading passthrough

The live request sent:

```json
{
  "tools": [
    { "type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex" },
    {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
      "defer_loading": true
    }
  ]
}
```

The HTTP 200 SSE stream contained, in order, content block types:

```text
text -> server_tool_use -> tool_search_tool_result -> text -> tool_use
```

The `tool_search_tool_result` contained a `tool_reference`, and the final `tool_use` targeted the deferred `get_weather` tool. This proves semantic request and response passthrough through the provider-native Anthropic gateway route. The log request/response payload subresource returned 404 for this gateway, so byte-for-byte stored-body comparison was unavailable; the upstream-native response is stronger evidence for the fields relevant to karmi.

## Reproduction (secrets stay outside the repository)

Expected private environment:

```sh
export CF_ACCOUNT_ID='...'
export AIG_GATEWAY='...'
export CF_AIG_TOKEN='...'
```

Send and capture a stream without printing identifiers:

```sh
headers_file="$(mktemp)"
body_file="$(mktemp)"
curl --silent --show-error --no-buffer \
  --dump-header "$headers_file" --output "$body_file" \
  "https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${AIG_GATEWAY}/anthropic/v1/messages" \
  -H "cf-aig-authorization: Bearer ${CF_AIG_TOKEN}" \
  -H 'cf-aig-skip-cache: true' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  --data '{"model":"claude-haiku-4-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Reply: ok"}]}'
log_id="$(awk 'BEGIN{IGNORECASE=1} /^cf-aig-log-id:/{gsub("\\r",""); print $2}' "$headers_file")"
test -n "$log_id" && printf '%s\n' 'log id present'
```

Poll the exact row without printing the ID:

```sh
curl --silent --show-error \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${AIG_GATEWAY}/logs/${log_id}" \
  -H "Authorization: Bearer ${CF_AIG_TOKEN}" \
  | jq '{success, result: (.result | {success, provider, model, tokens_in, tokens_out, cost})}'
```

Repeat until `result.cost` is non-null; record 404/error 7002 and null-cost states rather than treating either as terminal. Add a unique prompt and `cf-aig-skip-cache: true` for latency measurements.

## Explicit spec-line changes

1. `CONTEXT.md`'s `Usage` paragraph remains structurally correct: persist the Cloudflare `cf-aig-log-id` under `gateway`; do not put Cloudflare log cost synchronously into `usage.recorded`.
2. In `docs/research/cost-reporting.md` §8, change the direct-Anthropic accessor from “exact accessor UNVERIFIED” to verified `await client.messages.stream(...).withResponse()` -> `response.headers.get("cf-aig-log-id")`, with the no-provider-auth-header caveat above.
3. In the same table, replace “delay undocumented” as the only guidance with: live uncached samples ranged from already complete at `message_stop` to 1.471 s afterward; 404 and null `cost` are retryable; there is no documented SLA.
4. Remove `eventId` as a fallback when the log header is lost. `cf-aig-event-id` is not a queryable join key; retain `cf-aig-metadata` only for coarser search/recovery.
5. In `docs/research/deferred-tool-loading.md` §§2.7 and 7, replace Cloudflare passthrough “UNVERIFIED” with the verified provider-native Anthropic result above. No gateway-specific disable switch is required for these wire fields based on this probe.
6. Keep successful Unified Billing cost population marked unverified until credits exist and a successful UB request can be compared. The HTTP 402 row does not resolve that question.

## Sources

[CF-logs]: https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/
[CF-UB]: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
[CF-Anthropic]: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
[CF-BYOK]: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
[CF-gateway-core]: https://github.com/cloudflare/ai/blob/main/packages/gateway-core/src/gateway-fetch.ts
[SDK-stream-source]: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/MessageStream.ts
[SDK-stream-docs]: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
[Anthropic-tool-search]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
[Anthropic-tool-reference]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
