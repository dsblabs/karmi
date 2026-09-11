import { expect, it } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { aiSdk } from "../src/index.js";
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
