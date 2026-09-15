import { expect, it } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { aiSdk } from "../src/index";
import type { ProviderEvent } from "@karmi/core";

it("drives one model call through scopedFetch and reports text and usage", async () => {
  const requests: unknown[] = [];
  const scopedFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      [
        {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-test",
          choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
        },
        {
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const provider = aiSdk(({ modelId, fetch }) => createOpenAI({ apiKey: "test", fetch }).chat(modelId));
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "gpt-test",
      config: { adapter: "ai-sdk" },
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    },
    { fetch: scopedFetch, signal: new AbortController().signal },
  ))
    events.push(event);
  expect(requests).toHaveLength(1);
  expect(events).toContainEqual({ type: "part", index: 0, block: { type: "text", text: "Hello" } });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "message.end",
      stopReason: "end_turn",
      usage: expect.objectContaining({ input: 3, output: 1 }),
    }),
  );
});

it("rejects execution: provider MCP servers as an invalid request, since only the Anthropic adapter has a connector", async () => {
  const provider = aiSdk(({ modelId, fetch }) => createOpenAI({ apiKey: "test", fetch }).chat(modelId));
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "gpt-test",
      config: { adapter: "ai-sdk" },
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      mcpServers: [{ name: "crm", url: "https://crm.example/mcp" }],
    },
    { fetch: () => Promise.reject(new Error("no network expected")), signal: new AbortController().signal },
  ))
    events.push(event);
  expect(events).toEqual([
    expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "invalid_request", message: expect.stringContaining("crm") }),
    }),
  ]);
});

it("maps a granted web_search to Responses and applies the remaining call ceiling", async () => {
  const requests: unknown[] = [];
  const provider = aiSdk(({ modelId, fetch }) => createOpenAI({ apiKey: "test", fetch }).responses(modelId));
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "gpt-test",
      config: {
        adapter: "ai-sdk",
        providerOptions: { openai: { serverTools: [{ name: "web_search", type: "web_search_preview" }] } },
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }],
      providerTools: { tools: ["web_search"], maxCalls: 2 },
    },
    {
      signal: new AbortController().signal,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","created_at":1,"model":"gpt-test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  ))
    events.push(event);
  expect(requests).toContainEqual(
    expect.objectContaining({ tools: [{ type: "web_search_preview" }], max_tool_calls: 2 }),
  );
  expect(events.at(-1)).toMatchObject({ type: "message.end" });
});

it("records a Responses search result and replays it through the same adapter", async () => {
  const fixture = (await import("./fixtures/web-search.sse?raw")).default;
  const requests: unknown[] = [];
  const call = {
    signal: new AbortController().signal,
    fetch: async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(fixture, { headers: { "content-type": "text/event-stream" } });
    },
  };
  const provider = aiSdk(({ modelId, fetch }) => createOpenAI({ apiKey: "test", fetch }).responses(modelId));
  const request = {
    model: "gpt-test",
    config: { adapter: "ai-sdk" },
    messages: [],
    providerTools: { tools: ["web_search" as const] },
  };
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, call)) events.push(event);
  const parts = events.flatMap((e) => (e.type === "part" ? [e.block] : []));
  expect(parts).toEqual([
    expect.objectContaining({
      type: "server_tool",
      name: "web_search",
      id: "ws_1",
      result: {
        raw: expect.objectContaining({ type: "tool-result", toolCallId: "ws_1" }),
        summary: expect.stringContaining("https://example.com/karmi"),
      },
    }),
  ]);
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "message.end", usage: { serverToolCalls: 1 } });
  const replayed: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      ...request,
      messages: [{ role: "assistant", content: parts, provider: "ai-sdk", model: "gpt-test", stopReason: "end_turn" }],
    },
    call,
  ))
    replayed.push(event);
  expect(replayed.at(-1)).toMatchObject({ type: "message.end" });
  expect(requests[1]).toMatchObject({
    input: [expect.objectContaining({ type: "item_reference", id: "ws_1" })],
  });
});

it("rejects stateless replay of Provider Tools even after the grant is exhausted", async () => {
  const provider = aiSdk(({ modelId, fetch }) => createOpenAI({ apiKey: "test", fetch }).responses(modelId));
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "gpt-test",
      config: { adapter: "ai-sdk" },
      providerOptions: { aiSdk: { openai: { store: false } } },
      providerTools: { tools: [], maxCalls: 0 },
      messages: [
        {
          role: "assistant",
          provider: "ai-sdk",
          model: "gpt-test",
          stopReason: "end_turn",
          content: [{ type: "server_tool", id: "ws_1", name: "web_search", input: {} }],
        },
      ],
    },
    { signal: new AbortController().signal, fetch: () => Promise.reject(new Error("Must not send")) },
  ))
    events.push(event);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "invalid_request", message: expect.stringContaining("store") }),
    }),
  );
});
