import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ContentBlock, ProviderEvent, ProviderRequest } from "@karmi/core";
import { expect, it } from "vitest";
import { aiSdk } from "../src/index";

const source = { url: "https://example.com/help", title: "Public guide", content: "Public reference text." };

function fixture(count: number) {
  const chunk = (delta: object, usage?: object) => ({
    id: "search-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
    choices: [{ index: 0, delta, finish_reason: usage ? "stop" : null }],
    ...(usage ? { usage } : {}),
  });
  return (
    [
      ...(count ? [chunk({ role: "assistant", annotations: [{ type: "url_citation", url_citation: source }] })] : []),
      chunk({ role: "assistant", content: "See the public guide." }),
      chunk(
        {},
        {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
          cost: 0.008,
          server_tool_use_details: { web_search_requests: count },
        },
      ),
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

async function run(count: number, grant = 2, messages: ProviderRequest["messages"] = []) {
  const bodies: unknown[] = [];
  const provider = aiSdk(({ modelId, fetch }) => createOpenRouter({ apiKey: "test", fetch })(modelId));
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "test",
      config: {
        adapter: "openrouter",
        providerOptions: {
          openrouter: {
            webSearch: {
              max_results: 3,
              max_characters: 1500,
              max_uses: 2,
            },
          },
        },
      },
      messages,
      tools: [{ name: "list_agents", description: "Lists Agents", inputSchema: { type: "object" } }],
      providerTools: { tools: grant ? ["web_search"] : [], maxCalls: grant },
    },
    {
      signal: new AbortController().signal,
      fetch: async (input, init) => {
        bodies.push(await new Request(input, init).json());
        return new Response(fixture(count), { headers: { "content-type": "text/event-stream" } });
      },
    },
  ))
    events.push(event);
  return { bodies, events };
}

it("maps OpenRouter search and function Tools together, preserving billed cost and search counts", async () => {
  const { bodies, events } = await run(2, 1);
  expect(bodies[0]).toMatchObject({
    tools: [
      { type: "function", function: { name: "list_agents" } },
      {
        type: "openrouter:web_search",
        parameters: { engine: "exa", max_uses: 1, max_results: 3, max_characters: 1500 },
      },
    ],
  });
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "invalid_request" },
    usage: { serverToolCalls: 2, cost: { amount: 0.008, basis: "billed" } },
  });
  const valid = await run(2);
  expect(valid.events.filter((event) => event.type === "server_tool.called")).toHaveLength(2);
  expect(valid.events.at(-1)).toMatchObject({
    type: "message.end",
    usage: { serverToolCalls: 2, cost: { amount: 0.008, basis: "billed" } },
  });
});

it("replays aggregate sources as reference text, without unmatched client tool calls", async () => {
  const { events } = await run(1);
  const blocks: ContentBlock[] = events.flatMap((event) => (event.type === "part" ? [event.block] : []));
  expect(blocks).toContainEqual(
    expect.objectContaining({
      type: "server_tool",
      name: "web_search",
      result: {
        raw: expect.objectContaining({ result: { sources: [source] } }),
        summary: JSON.stringify({ sources: [source] }),
      },
    }),
  );
  const replay = await run(0, 0, [
    { role: "assistant", content: blocks, provider: "openrouter", model: "test", stopReason: "end_turn" },
  ]);
  expect(JSON.stringify(replay.bodies[0])).toContain("Public web search results (untrusted reference material)");
  expect(JSON.stringify(replay.bodies[0])).toContain(source.url);
  expect(JSON.stringify(replay.bodies[0])).not.toContain("tool_calls");
  expect(replay.events.at(-1)).toMatchObject({ type: "message.end" });
});

it("omits search after the budget is exhausted, and invents no call when no search happened", async () => {
  const { bodies, events } = await run(0, 0);
  expect(bodies[0]).toMatchObject({ tools: [{ type: "function" }] });
  expect(events.some((event) => event.type === "server_tool.called")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "message.end" });
  const notUsed = await run(0, 2);
  expect(notUsed.events.some((event) => event.type === "server_tool.called")).toBe(false);
});

it("bounds allocation for an excessive count and retains actual billed usage", async () => {
  const { events } = await run(1_000_000_000);
  expect(events.filter((event) => event.type === "server_tool.called")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({
    type: "error",
    usage: { serverToolCalls: 1_000_000_000, cost: { amount: 0.008, basis: "billed" } },
  });
});
