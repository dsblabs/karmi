import { expect, it } from "vitest";
import type { ProviderEvent } from "../src/index";
import { scope, serverProvider, provider, trace } from "./worker";

const message = { kind: "message" as const, parts: [{ type: "text" as const, text: "Search" }] };
const raw = { type: "web_search_tool_result", tool_use_id: "search-1", content: "x".repeat(1000) };
const stream: ProviderEvent[] = [
  {
    type: "part",
    index: 0,
    block: {
      type: "server_tool",
      id: "search-1",
      name: "web_search",
      input: { query: "news" },
      result: { raw, summary: "Found news." },
    },
  },
  { type: "message.end", stopReason: "pause_turn", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
];

it("gates requests, records spilled Provider Tools, and keeps Turn and Thread budgets across sends", async () => {
  await scope.agents.put({
    agentId: "searcher",
    name: "Searcher",
    instructions: [],
    model: { id: "anthropic/claude-sonnet-5", providerProfile: "server" },
    capabilities: {
      providerTools: { tools: ["web_search", "web_fetch"], limits: { maxCallsPerTurn: 1, maxCallsPerThread: 2 } },
    },
    policy: [{ match: { tool: "web_fetch" }, effect: "deny" }],
    context: { toolOutput: { maxChars: 100 } },
  });
  serverProvider.script([stream, "Done", stream, "Done", "Exhausted"]);
  const thread = scope.thread({ agent: "searcher", threadId: "provider-tools" });
  const events = await thread.send(message);
  expect(events).toHaveSequence(["server_tool.called", "server_tool.result", "usage.recorded", "step.completed"]);
  expect(events.some((e) => e.type === "tool.call")).toBe(false);
  expect(events.find((e) => e.type === "server_tool.result")).toMatchObject({
    raw: { key: expect.any(String) },
    summary: "Found news.",
  });
  expect(serverProvider.requests[0]).toMatchObject({
    providerTools: { tools: ["web_search"], maxCalls: 1 },
    system: expect.stringContaining("web_search"),
  });
  expect(serverProvider.requests[1]).toMatchObject({ providerTools: { tools: [], maxCalls: 0 } });
  expect(JSON.stringify(serverProvider.requests[1]?.messages)).toContain(JSON.stringify(raw));
  await thread.send(message);
  await thread.send(message);
  expect(serverProvider.requests[2]?.providerTools?.tools).toEqual(["web_search"]);
  expect(serverProvider.requests[4]?.providerTools?.tools).toEqual([]);
  expect((await thread.status()).usage.serverToolCalls).toBe(2);
});

it("applies an omitted Scope limit, observes results, and replays summaries after a provider switch", async () => {
  await scope.config.set({ ceilings: { providerTools: { limits: { maxCallsPerThread: 1 } } } });
  await scope.agents.put({
    agentId: "bounded-searcher",
    name: "Searcher",
    instructions: [],
    model: { id: "anthropic/claude-sonnet-5", providerProfile: "server" },
    capabilities: { providerTools: { tools: ["web_search"] } },
    hooks: { "before-tool": ["deny-lookup"], "after-tool": ["observe"] },
  });
  serverProvider.script([stream, "Done", "No search"]);
  const thread = scope.thread({ agent: "bounded-searcher", threadId: "bounded-provider-tools" });
  await thread.send(message);
  await thread.send(message);
  expect(serverProvider.requests[0]?.providerTools?.maxCalls).toBe(1);
  expect(serverProvider.requests[2]?.providerTools?.tools).toEqual([]);
  expect(trace).toContain("after-tool:web_search:ok");
  await scope.agents.put({
    agentId: "bounded-searcher",
    name: "Searcher",
    instructions: [],
    model: { id: "other/model", providerProfile: "default" },
  });
  provider.script(["Switched"]);
  await thread.send(message);
  const replay = JSON.stringify(provider.requests[0]?.messages);
  expect(replay).toContain("Found news.");
  expect(replay).not.toContain("server_tool");
  expect(replay).not.toContain("x".repeat(100));
});

it("keeps a started call spent when the provider stream fails before its result", async () => {
  await scope.agents.put({
    agentId: "interrupted-searcher",
    name: "Searcher",
    instructions: [],
    model: { id: "anthropic/claude-sonnet-5", providerProfile: "server" },
    capabilities: { providerTools: { tools: ["web_search"], limits: { maxCallsPerThread: 1 } } },
  });
  serverProvider.script([
    [
      { type: "server_tool.called", block: { type: "server_tool", id: "started", name: "web_search", input: {} } },
      { type: "error", error: { code: "invalid_request", retryable: false, message: "Failed after starting search" } },
    ],
    "Recovered",
  ]);
  const thread = scope.thread({ agent: "interrupted-searcher", threadId: "interrupted-provider-tools" });
  const events = await thread.send(message);
  expect(events).toHaveSequence(["server_tool.called", "turn.failed"]);
  expect(events.some((e) => e.type === "server_tool.result")).toBe(false);
  await thread.send(message);
  expect(serverProvider.requests[1]?.providerTools?.tools).toEqual([]);
});

it("spills large call payloads and restores their inputs for same-provider replay", async () => {
  await scope.agents.put({
    agentId: "large-searcher",
    name: "Searcher",
    instructions: [],
    model: { id: "anthropic/claude-sonnet-5", providerProfile: "server" },
    capabilities: { providerTools: { tools: ["web_search"], limits: { maxCallsPerTurn: 1 } } },
    context: { toolOutput: { maxChars: 100 } },
  });
  const input = { query: "large".repeat(1000) };
  const native = { type: "server_tool_use", id: "large", name: "web_search", input };
  serverProvider.script([
    [
      {
        type: "part",
        index: 0,
        block: {
          type: "server_tool",
          id: "large",
          name: "web_search",
          input,
          raw: native,
          result: { raw: { type: "web_search_tool_result", content: [] }, summary: "Empty." },
        },
      },
      { type: "message.end", stopReason: "pause_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    ],
    "Done",
  ]);
  const events = await scope.thread({ agent: "large-searcher", threadId: "large-provider-tools" }).send(message);
  expect(JSON.stringify(events)).not.toContain(input.query);
  expect(events.find((e) => e.type === "server_tool.called")).toMatchObject({ raw: { key: expect.any(String) } });
  expect(serverProvider.requests[1]?.messages).toContainEqual(
    expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ input, raw: native })] }),
  );
});

it("replays summaries when switching vendors within the AI SDK adapter", async () => {
  await scope.agents.put({
    agentId: "sdk-switch",
    name: "Switcher",
    instructions: [],
    model: { id: "openai/gpt-test", providerProfile: "server-sdk" },
    capabilities: { providerTools: { tools: ["web_search"] } },
  });
  serverProvider.script([stream, "Done", "Switched"]);
  const thread = scope.thread({ agent: "sdk-switch", threadId: "sdk-vendor-switch" });
  await thread.send(message);
  await scope.agents.put({
    agentId: "sdk-switch",
    name: "Switcher",
    instructions: [],
    model: { id: "google/gemini-test", providerProfile: "server-sdk" },
  });
  await thread.send(message);
  expect(JSON.stringify(serverProvider.requests[2]?.messages)).toContain("Found news.");
  expect(JSON.stringify(serverProvider.requests[2]?.messages)).not.toContain("server_tool");
});
