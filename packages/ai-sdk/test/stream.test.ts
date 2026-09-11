import { APICallError } from "@ai-sdk/provider";
import { expect, it } from "vitest";
import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ProviderEvent, ContentBlock, ProviderRequest } from "@karmi/core";
import { aiSdk } from "../src/index";

const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "end_turn" },
  usage: {
    inputTokens: { total: 20, noCache: 5, cacheRead: 10, cacheWrite: 5 },
    outputTokens: { total: 7, text: 4, reasoning: 3 },
  },
};
const request: ProviderRequest = { model: "test", config: { adapter: "ai-sdk" }, messages: [] };
const call = { fetch, signal: new AbortController().signal };
function setup(parts: LanguageModelV4StreamPart[], provider = "anthropic.messages") {
  const requests: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider,
    modelId: "test",
    supportedUrls: { "image/*": [/^https:/] },
    doGenerate() {
      throw new Error("Must never use doGenerate");
    },
    doStream(options) {
      requests.push(options);
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      });
    },
  };
  return { adapter: aiSdk(() => model), requests };
}
async function collect(events: AsyncIterable<ProviderEvent>) {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function blocks(events: ProviderEvent[]): ContentBlock[] {
  return events.flatMap((event) => (event.type === "part" ? [event.block] : []));
}

it("preserves compaction, signatures, MCP results, fallback iterations and raw events for replay", async () => {
  const raw = { type: "future-provider-event", value: "opaque" };
  const { adapter, requests } = setup([
    { type: "raw", rawValue: raw },
    { type: "text-start", id: "c", providerMetadata: { anthropic: { type: "compaction" } } },
    { type: "text-delta", id: "c", delta: "Summary" },
    { type: "text-end", id: "c" },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Thought" },
    { type: "reasoning-end", id: "r", providerMetadata: { anthropic: { signature: "signed" } } },
    {
      type: "tool-call",
      toolCallId: "mcp",
      toolName: "search",
      input: '{"q":"x"}',
      providerExecuted: true,
      providerMetadata: { anthropic: { type: "mcp-tool-use", serverName: "docs" } },
    },
    {
      type: "tool-result",
      toolCallId: "mcp",
      toolName: "search",
      result: { content: "Found" },
      providerMetadata: { anthropic: { type: "mcp-tool-result" } },
    },
    {
      ...finish,
      providerMetadata: { anthropic: { iterations: [{ type: "fallback_message", model: "fallback-model" }] } },
    },
  ]);
  const events = await collect(adapter.stream(request, call));
  expect(events).toContainEqual({ type: "raw", raw });
  expect(blocks(events).map((block) => block.type)).toEqual(["compaction", "thinking", "server_tool", "provider"]);
  await collect(
    adapter.stream(
      {
        ...request,
        messages: [
          { role: "assistant", provider: "ai-sdk", model: "test", stopReason: "end_turn", content: blocks(events) },
        ],
      },
      call,
    ),
  );
  expect(requests[1]?.prompt).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Summary", providerOptions: { anthropic: { type: "compaction" } } },
        { type: "reasoning", text: "Thought", providerOptions: { anthropic: { signature: "signed" } } },
        {
          type: "tool-call",
          toolCallId: "mcp",
          toolName: "search",
          input: { q: "x" },
          providerExecuted: true,
          providerOptions: { anthropic: { type: "mcp-tool-use", serverName: "docs" } },
        },
        {
          type: "tool-result",
          toolCallId: "mcp",
          toolName: "search",
          output: { type: "json", value: { content: "Found" } },
          providerOptions: { anthropic: { type: "mcp-tool-result" } },
        },
      ],
    },
  ]);
});

it.each([
  {
    provider: "gateway",
    part: { ...finish, providerMetadata: { gateway: { cost: "0.012", byok: true } } },
    cost: { amount: 0.012, currency: "USD", source: "vercel-gateway", basis: "billed", byok: true },
  },
  {
    provider: "openrouter.chat",
    part: {
      ...finish,
      usage: { ...finish.usage, raw: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.04 } } },
    },
    cost: { amount: 0, currency: "USD", source: "openrouter", basis: "billed", upstream: 0.04, byok: true },
  },
])("reports only finish-time billed cost from $provider", async ({ provider, part, cost }) => {
  const { adapter } = setup([part], provider);
  expect(await collect(adapter.stream(request, call))).toContainEqual(
    expect.objectContaining({ type: "message.end", usage: expect.objectContaining({ cost }) }),
  );
});

it.each([null, "", "NaN", "Infinity", -1])("omits invalid gateway cost %s", async (cost) => {
  const { adapter } = setup([{ ...finish, providerMetadata: { gateway: { cost } } }]);
  const events = await collect(adapter.stream(request, call));
  const end = events.find((event) => event.type === "message.end");
  expect(end?.usage.cost).toBeUndefined();
});

it("fails a truncated stream and never emits a second terminal event after an SDK error", async () => {
  const truncated = setup([{ type: "text-start", id: "1" }]);
  expect(await collect(truncated.adapter.stream(request, call))).toContainEqual(
    expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "network" }) }),
  );
  const failed = setup([{ type: "error", error: new Error("broken") }, finish]);
  const events = await collect(failed.adapter.stream(request, call));
  expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  expect(events.some((event) => event.type === "message.end")).toBe(false);
});

it("validates options before invoking the model factory and maps reasoning off", async () => {
  const { adapter, requests } = setup([finish]);
  const events = await collect(adapter.stream({ ...request, providerOptions: { aiSdk: { openai: "invalid" } } }, call));
  expect(events[0]).toMatchObject({ type: "error", error: { code: "invalid_request" } });
  expect(requests).toHaveLength(0);
  await collect(
    adapter.stream(
      { ...request, params: { reasoning: "off" }, providerOptions: { aiSdk: { openai: { store: false } } } },
      call,
    ),
  );
  expect(requests[0]).toMatchObject({
    reasoning: "none",
    includeRawChunks: true,
    providerOptions: { openai: { store: false } },
  });
  expect(adapter.capabilities("test")).toEqual({ image: true, audio: "unknown", video: "unknown", pdf: "unknown" });
});

it("offers a deferred Tool only once a tool_reference in the transcript loads it, rendering the reference as text", async () => {
  const { adapter, requests } = setup([finish]);
  const tools = [
    { name: "shelf_01", description: "Maps", inputSchema: { type: "object" }, deferred: true },
    { name: "shelf_02", description: "Charts", inputSchema: { type: "object" }, deferred: true },
    { name: "tool_search", description: "Search", inputSchema: { type: "object" } },
  ];
  await collect(adapter.stream({ ...request, tools }, call));
  expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["tool_search"]);
  await collect(
    adapter.stream(
      {
        ...request,
        tools,
        messages: [
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "tool_search",
            content: [{ type: "tool_reference", name: "shelf_02" }],
            isError: false,
          },
        ],
      },
      call,
    ),
  );
  expect(requests[1]?.tools).toEqual([
    { type: "function", name: "shelf_02", description: "Charts", inputSchema: { type: "object" } },
    { type: "function", name: "tool_search", description: "Search", inputSchema: { type: "object" } },
  ]);
  expect(requests[1]?.prompt).toEqual([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "tool_search",
          output: { type: "text", value: 'Tool "shelf_02" is now loaded.' },
        },
      ],
    },
  ]);
});

it("cancels the underlying stream when the consumer stops at message.start", async () => {
  let cancelled = false;
  const adapter = aiSdk(() => ({
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate() {
      throw new Error("Only streaming");
    },
    async doStream() {
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            cancelled = true;
          },
        }),
      };
    },
  }));
  for await (const event of adapter.stream(request, call)) {
    expect(event.type).toBe("message.start");
    break;
  }
  expect(cancelled).toBe(true);
});

it("does not open a model call after cancellation with a custom reason", async () => {
  const controller = new AbortController();
  controller.abort("User cancelled");
  const { adapter, requests } = setup([finish]);
  const events = await collect(adapter.stream(request, { ...call, signal: controller.signal }));
  expect(events).toEqual([{ type: "error", error: { code: "aborted", message: "User cancelled", retryable: false } }]);
  expect(requests).toHaveLength(0);
});

it.each([
  { status: 401, code: "auth", retryable: false },
  { status: 402, code: "quota", retryable: false },
  { status: 429, code: "rate_limit", retryable: true },
  { status: 503, code: "unavailable", retryable: true },
  { status: undefined, code: "network", retryable: true },
])("classifies SDK failures with status $status", async ({ status, code, retryable }) => {
  const error = new APICallError({
    message: "Provider failed",
    url: "https://example.com",
    requestBodyValues: {},
    ...(status === undefined ? {} : { statusCode: status }),
    isRetryable: retryable,
  });
  const { adapter } = setup([{ type: "error", error }]);
  const events = await collect(adapter.stream(request, call));
  expect(events.at(-1)).toMatchObject({ type: "error", error: { code, retryable } });
});
