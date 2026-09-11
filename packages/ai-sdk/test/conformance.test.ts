import { expect, it } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import mcp from "./fixtures/anthropic-mcp.sse?raw";
import fallback from "../../anthropic/test/fixtures/fallback.sse?raw";
import compaction from "../../anthropic/test/fixtures/compaction.sse?raw";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI as gatewayOpenAI } from "ai-gateway-provider/providers/openai";
import type { ProviderEvent } from "@karmi/core";
import { aiSdk, type ModelFactory } from "../src/index.js";
import openai from "./fixtures/openai.sse?raw";
import google from "./fixtures/google.sse?raw";
import router from "./fixtures/openrouter.sse?raw";
import gateway from "./fixtures/gateway.sse?raw";
import workers from "./fixtures/workers-ai.sse?raw";

const cases: { name: string; fixture: string; factory: ModelFactory }[] = [
  { name: "openai", fixture: openai, factory: ({ fetch }) => createOpenAI({ apiKey: "test", fetch }).chat("gpt-test") },
  {
    name: "google",
    fixture: google,
    factory: ({ fetch }) => createGoogleGenerativeAI({ apiKey: "test", fetch })("gemini-3-flash-preview"),
  },
  {
    name: "compatible",
    fixture: openai,
    factory: ({ fetch }) =>
      createOpenAICompatible({ name: "compatible", baseURL: "https://example.com/v1", fetch }).chatModel("test"),
  },
  {
    name: "openrouter",
    fixture: router,
    factory: ({ fetch }) => createOpenRouter({ apiKey: "test", fetch }).chat("openai/test"),
  },
  {
    name: "gateway",
    fixture: gateway,
    factory: ({ fetch }) => createGateway({ apiKey: "test", fetch })("openai/test"),
  },
  {
    name: "workers-ai",
    fixture: workers,
    factory: ({ fetch }) =>
      createWorkersAI({ accountId: "test", apiKey: "test", fetch })("@cf/meta/llama-3.1-8b-instruct"),
  },
  {
    name: "cloudflare-gateway",
    fixture: openai,
    factory: ({ fetch }) =>
      createAiGateway({
        binding: {
          run: (data, options) =>
            fetch("https://gateway.ai.cloudflare.com/v1/test/test", {
              method: "POST",
              body: JSON.stringify(data),
              signal: options?.signal ?? null,
            }),
        },
      })(gatewayOpenAI({ apiKey: "test" }).chat("gpt-test")),
  },
];
it.each(cases)("streams $name through the supplied fetch", async ({ factory, fixture, name }) => {
  let calls = 0;
  let sent: unknown;
  const scopedFetch: typeof fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    calls++;
    return new Response(fixture, { headers: { "content-type": "text/event-stream" } });
  };
  const events: ProviderEvent[] = [];
  for await (const event of aiSdk(factory).stream(
    {
      model: "test",
      params: { reasoning: "high" },
      config: { adapter: "ai-sdk" },
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    },
    { fetch: scopedFetch, signal: new AbortController().signal },
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(calls).toBe(1);
  const expected: Record<string, object> = {
    openai: { reasoning_effort: "high" },
    google: { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } },
    compatible: { reasoning_effort: "high" },
    openrouter: { reasoning: { effort: "high" } },
    gateway: { reasoning: "high" },
    "workers-ai": { reasoning_effort: "high" },
    "cloudflare-gateway": [{ query: { reasoning_effort: "high" } }],
  };
  expect(sent).toMatchObject(expected[name] ?? {});
  expect(events).toContainEqual(
    expect.objectContaining({ type: "part", block: expect.objectContaining({ type: "text", text: "Hello" }) }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "message.end",
      stopReason: "end_turn",
      usage: expect.objectContaining({ input: 3, output: 1 }),
    }),
  );
  if (name === "openrouter" || name === "gateway")
    expect(events.find((event) => event.type === "message.end")?.usage.cost).toMatchObject({
      amount: 0.001,
      basis: "billed",
      byok: true,
    });
});

it.each([
  {
    name: "compaction",
    fixture: compaction,
    block: { type: "compaction", summary: "The user asked about the weather." },
  },
  { name: "MCP", fixture: mcp, block: { type: "server_tool", id: "mcptoolu_01", name: "echo", input: { text: "hi" } } },
  {
    name: "fallback",
    fixture: fallback,
    block: { type: "provider", raw: { type: "fallback", model: "claude-sonnet-5" } },
  },
])("replays the Anthropic $name stream through the real AI SDK parser", async ({ fixture, block }) => {
  const adapter = aiSdk(({ fetch }) => createAnthropic({ apiKey: "test", fetch })("claude-sonnet-5"));
  const scopedFetch: typeof fetch = async () =>
    new Response(fixture, { headers: { "content-type": "text/event-stream" } });
  const events: ProviderEvent[] = [];
  for await (const event of adapter.stream(
    { model: "claude-sonnet-5", config: { adapter: "ai-sdk" }, messages: [] },
    { fetch: scopedFetch, signal: new AbortController().signal },
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  const actual = events.find((event) => event.type === "part" && event.block.type === block.type);
  expect(actual).toMatchObject({ type: "part", block });
});
