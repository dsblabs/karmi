import { describe, expect, it } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { aiSdk, type AiSdkOptions, type ModelFactory } from "../src/index";
import type { ProviderRequest } from "@karmi/core";

const request: ProviderRequest = {
  model: "claude-sonnet-5",
  config: { adapter: "ai-sdk" },
  system: "Be brief.",
  tools: [
    { name: "first", description: "First.", inputSchema: { type: "object" } },
    { name: "second", description: "Second.", inputSchema: { type: "object" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "first", input: {} }],
      provider: "anthropic",
      model: "claude-sonnet-5",
      stopReason: "tool_use",
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "first",
      content: [{ type: "text", text: "Done" }],
      isError: false,
    },
  ],
};

/** Runs one call and returns the JSON body that the SDK client sent. The fake API always fails. */
async function send(factory: (fetch: typeof globalThis.fetch) => ModelFactory, options?: AiSdkOptions) {
  const bodies: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 400 });
  };
  const provider = aiSdk(factory(fetch), options);
  for await (const _event of provider.stream(request, { fetch, signal: new AbortController().signal }));
  return bodies[0];
}

const anthropic = (fetch: typeof globalThis.fetch): ModelFactory => {
  return ({ modelId }) => createAnthropic({ apiKey: "test", fetch })(modelId);
};
const openRouter = (fetch: typeof globalThis.fetch): ModelFactory => {
  return ({ modelId }) => createOpenRouter({ apiKey: "test", fetch }).chat(`anthropic/${modelId}`);
};

describe("cache", () => {
  it("marks the system prompt, the last Tool and the last message by default", async () => {
    const body = await send(anthropic);
    expect(body).toMatchObject({
      system: [{ text: "Be brief.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "first" }, { name: "second", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user" },
        { role: "assistant" },
        { role: "user", content: [{ type: "tool_result", cache_control: { type: "ephemeral" } }] },
      ],
    });
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
  });

  it("sends the TTL that the option sets", async () => {
    const body = await send(anthropic, { cache: { ttl: "1h" } });
    expect(body).toMatchObject({ system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] });
  });

  it("sends no breakpoint with cache: false", async () => {
    expect(JSON.stringify(await send(anthropic, { cache: false }))).not.toContain("cache_control");
  });

  it("marks the system prompt and the last message through OpenRouter", async () => {
    expect(await send(openRouter)).toMatchObject({
      messages: [
        { role: "system", content: [{ text: "Be brief.", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "Hi" },
        { role: "assistant" },
        { role: "tool", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("does not change the request", async () => {
    const before = structuredClone(request);
    await send(anthropic);
    expect(request).toEqual(before);
  });
});

describe("capabilities", () => {
  const openai = (fetch: typeof globalThis.fetch): ModelFactory => {
    return ({ modelId }) => createOpenAI({ apiKey: "test", fetch }).chat(modelId);
  };

  it("reports the given context window before the first call and merges it with what a call learns", async () => {
    const bodies: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      bodies.push(init?.body);
      return new Response("{}", { status: 400 });
    };
    const provider = aiSdk(openai(fetch), {
      capabilities: (modelId) => (modelId === "gpt-test" ? { contextWindow: 128_000, pdf: false } : undefined),
    });
    expect(provider.capabilities("gpt-test")).toEqual({
      image: "unknown",
      audio: "unknown",
      video: "unknown",
      pdf: false,
      contextWindow: 128_000,
    });
    expect(provider.capabilities("other").contextWindow).toBeUndefined();
    for await (const _event of provider.stream(
      { ...request, model: "gpt-test" },
      { fetch, signal: new AbortController().signal },
    ));
    expect(bodies).toHaveLength(1);
    expect(provider.capabilities("gpt-test")).toMatchObject({ image: true, pdf: false, contextWindow: 128_000 });
  });

  it("reports only the learned capabilities without the option", () => {
    expect(aiSdk(openai(globalThis.fetch)).capabilities("gpt-test").contextWindow).toBeUndefined();
  });
});
