import { describe, expect, it } from "vitest";
import { sensitive, type Message } from "@karmi/core";
import { anthropic } from "../src/index";
import text from "./fixtures/text.sse?raw";
import { collect, request, serve } from "./helpers";

const provider = anthropic({ apiKey: "sk-test" });

async function sent(overrides: Parameters<typeof request>[0]) {
  const server = serve({ sse: text });
  await collect(provider, request(overrides), server);
  return server.calls[0]!;
}

describe("request building", () => {
  it("puts execution: provider servers on the MCP connector with the registry's token and the allow/deny lists", async () => {
    const call = await sent({
      mcpServers: [
        { name: "crm", url: "https://crm.example/mcp", authorization: sensitive("at-1"), allow: ["contacts"] },
        { name: "docs", url: "https://docs.example/mcp", deny: ["delete"] },
      ],
    });
    expect(call.body).toMatchObject({
      mcp_servers: [
        { type: "url", name: "crm", url: "https://crm.example/mcp", authorization_token: "at-1" },
        { type: "url", name: "docs", url: "https://docs.example/mcp" },
      ],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: "crm",
          default_config: { enabled: false },
          configs: { contacts: { enabled: true } },
        },
        { type: "mcp_toolset", mcp_server_name: "docs", configs: { delete: { enabled: false } } },
      ],
    });
    expect(call.headers["anthropic-beta"]).toContain("mcp-client-2025-11-20");
  });

  it("posts to the Messages API with the key, a default max_tokens and cache breakpoints on system and the last message", async () => {
    const call = await sent({ system: "Be brief." });
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call.headers["x-api-key"]).toBe("sk-test");
    expect(call.body).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 16384,
      stream: true,
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] }],
    });
  });

  it("maps params: max tokens, temperature, top-p, and reasoning to adaptive thinking plus effort", async () => {
    expect(
      (await sent({ params: { maxOutputTokens: 800, temperature: 0.2, topP: 0.9, reasoning: "high" } })).body,
    ).toMatchObject({
      max_tokens: 800,
      temperature: 0.2,
      top_p: 0.9,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect((await sent({ params: { reasoning: "off" } })).body).toMatchObject({ thinking: { type: "disabled" } });
    const plain = (await sent({})).body!;
    expect(plain).not.toHaveProperty("thinking");
    expect(plain).not.toHaveProperty("output_config");
  });

  it("forwards providerOptions.anthropic and adds the betas each feature needs, merging a profile header's betas", async () => {
    const call = await sent({
      config: { adapter: "anthropic", headers: { "anthropic-beta": "interleaved-thinking-2025-05-14, extra-beta" } },
      providerOptions: {
        anthropic: {
          effort: "max",
          fallbacks: "default",
          taskBudget: { type: "tokens", total: 50000 },
          contextManagement: { edits: [{ type: "compact_20260112" }] },
          mcpServers: [{ type: "url", url: "https://mcp.example.com", name: "demo" }],
          betas: ["my-beta"],
          cache: { ttl: "1h" },
        },
      },
    });
    expect(call.body).toMatchObject({
      output_config: { effort: "max", task_budget: { type: "tokens", total: 50000 } },
      fallbacks: "default",
      context_management: { edits: [{ type: "compact_20260112" }] },
      mcp_servers: [{ type: "url", url: "https://mcp.example.com", name: "demo" }],
    });
    expect(call.headers["anthropic-beta"]!.split(",").sort()).toEqual([
      "compact-2026-01-12",
      "extra-beta",
      "interleaved-thinking-2025-05-14",
      "mcp-client-2025-11-20",
      "my-beta",
      "server-side-fallback-2026-07-01",
      "task-budgets-2026-03-13",
    ]);
    expect((call.body!.messages as { content: { cache_control: unknown }[] }[])[0]!.content[0]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("turns a Harness compact request into a forced compaction edit that pauses with the block", async () => {
    const call = await sent({ compact: { instructions: "Keep the names." } });
    expect(call.body).toMatchObject({
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 50_000 },
            pause_after_compaction: true,
            instructions: "Keep the names.",
          },
        ],
      },
    });
    expect(call.headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect((await sent({ compact: {} })).body).toMatchObject({
      context_management: { edits: [{ type: "compact_20260112", pause_after_compaction: true }] },
    });
  });

  it("sends Tools with strict and a cache breakpoint on the last one, appends server tools, and maps tool choice", async () => {
    const tools = [
      {
        name: "weather",
        description: "Weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
        strict: true,
      },
      { name: "lookup", description: "Lookup", inputSchema: { type: "object" } },
    ];
    const call = await sent({
      tools,
      toolChoice: { name: "weather" },
      parallelToolCalls: false,
      providerTools: { tools: ["web_search"] },
      providerOptions: {
        anthropic: { serverTools: [{ type: "web_search_20260318", name: "web_search" }], cache: false },
      },
    });
    expect(call.body!.tools).toEqual([
      {
        name: "weather",
        description: "Weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
        strict: true,
      },
      { name: "lookup", description: "Lookup", input_schema: { type: "object" } },
      { type: "web_search_20260318", name: "web_search" },
    ]);
    expect(call.body!.tool_choice).toEqual({ type: "tool", name: "weather", disable_parallel_tool_use: true });
    expect((await sent({ tools, toolChoice: "any" })).body).toMatchObject({
      tool_choice: { type: "any" },
      tools: [expect.anything(), expect.objectContaining({ cache_control: { type: "ephemeral" } })],
    });
    expect((await sent({ tools, toolChoice: "none" })).body).toMatchObject({ tool_choice: { type: "none" } });
  });

  it("replays every block family: thinking with signatures, tool calls, results merged with the next user turn, server tools, compaction, provider raw, system mid-conversation", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Search and book" },
          { type: "media", media: { id: "m1", key: "k", mimeType: "image/png", bytes: 10, name: "pic.png" } },
        ],
      },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "tool_use",
        content: [
          { type: "thinking", text: "plan", signature: "sig1" },
          { type: "thinking", text: "unsigned" },
          { type: "thinking", text: "", signature: "BLOB", redacted: true },
          {
            type: "server_tool",
            id: "srv1",
            name: "web_search",
            input: { query: "q" },
            result: { raw: { type: "web_search_tool_result", tool_use_id: "srv1", content: [] }, summary: "nothing" },
          },
          {
            type: "compaction",
            summary: "earlier",
            raw: { type: "compaction", content: "earlier", encrypted_content: "E" },
          },
          { type: "provider", raw: { type: "fallback", from: { model: "a" }, to: { model: "b" } } },
          { type: "text", text: "   " },
          { type: "tool_call", id: "t1", name: "book", input: { room: 1 } },
          { type: "tool_call", id: "t2", name: "lookup", input: { id: "g" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "book",
        content: [{ type: "text", text: "Booked" }],
        isError: false,
      },
      { role: "toolResult", toolCallId: "t2", toolName: "lookup", content: [], isError: true },
      { role: "system", content: "Be terse now." },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
        content: [{ type: "compaction", summary: "cross-provider summary" }],
      },
      { role: "user", content: [{ type: "text", text: "Go on" }] },
    ];
    const call = await sent({ messages, providerOptions: { anthropic: { cache: false } } });
    expect(call.body!.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Search and book" },
          { type: "text", text: "[media unavailable]" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", signature: "sig1" },
          { type: "redacted_thinking", data: "BLOB" },
          { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "srv1", content: [] },
          { type: "compaction", content: "earlier", encrypted_content: "E" },
          { type: "fallback", from: { model: "a" }, to: { model: "b" } },
          { type: "tool_use", id: "t1", name: "book", input: { room: 1 } },
          { type: "tool_use", id: "t2", name: "lookup", input: { id: "g" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "Booked" }] },
          { type: "tool_result", tool_use_id: "t2", is_error: true },
        ],
      },
      { role: "system", content: "Be terse now." },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      { role: "assistant", content: [{ type: "text", text: "cross-provider summary" }] },
      { role: "user", content: [{ type: "text", text: "Go on" }] },
    ]);
    expect(call.headers["anthropic-beta"]).toBe("compact-2026-01-12");
  });

  it("defers Tools natively: defer_loading last and uncached, references in the tool_result, text as siblings", async () => {
    const tools = [
      { name: "shelf_01", description: "Maps", inputSchema: { type: "object" }, deferred: true },
      { name: "weather", description: "Weather", inputSchema: { type: "object" } },
      { name: "tool_search", description: "Search", inputSchema: { type: "object" } },
    ];
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Maps" }] },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: "t1", name: "tool_search", input: { query: "select:shelf_01,nope" } }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "tool_search",
        content: [
          { type: "tool_reference", name: "shelf_01" },
          { type: "text", text: "Not in the deferred index: nope." },
        ],
        isError: false,
      },
    ];
    const call = await sent({ tools, messages });
    expect(call.body!.tools).toEqual([
      { name: "weather", description: "Weather", input_schema: { type: "object" } },
      {
        name: "tool_search",
        description: "Search",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
      { name: "shelf_01", description: "Maps", input_schema: { type: "object" }, defer_loading: true },
    ]);
    expect((call.body!.messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: false,
          content: [{ type: "tool_reference", tool_name: "shelf_01" }],
        },
        { type: "text", text: "Not in the deferred index: nope.", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("puts the cache breakpoint on the last tool_result when that ends the conversation", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Book" }] },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: "t1", name: "book", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "book",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ];
    const call = await sent({ messages });
    expect((call.body!.messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: false,
          content: [{ type: "text", text: "ok" }],
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });
});

describe("countTokens and capabilities", () => {
  it("counts tokens through count_tokens with only the fields it accepts", async () => {
    const server = serve({ status: 200, json: { input_tokens: 42 } });
    const result = await provider.countTokens!(
      request({
        system: "S",
        tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
        params: { reasoning: "low", maxOutputTokens: 5, temperature: 1 },
      }),
      { fetch: server.fetch, signal: new AbortController().signal },
    );
    expect(result).toEqual({ tokens: 42 });
    expect(server.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(Object.keys(server.calls[0]!.body!).sort()).toEqual([
      "messages",
      "model",
      "output_config",
      "system",
      "thinking",
      "tools",
    ]);
  });

  it("returns a tagged error instead of throwing", async () => {
    const result = await provider.countTokens!(request(), {
      fetch: serve({
        status: 401,
        json: { type: "error", error: { type: "authentication_error", message: "bad key" } },
      }).fetch,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      error: {
        code: "auth",
        message: "bad key",
        retryable: false,
        status: 401,
        raw: { type: "error", error: { type: "authentication_error", message: "bad key" } },
      },
    });
  });

  it("knows the Claude families and sends optimistically for anything else", () => {
    expect(provider.capabilities("claude-sonnet-5")).toEqual({
      image: true,
      audio: false,
      video: false,
      pdf: true,
      maxMediaBytes: 32 * 1024 * 1024,
      contextWindow: 200_000,
    });
    expect(provider.capabilities("claude-haiku-4-5-20251001")).toMatchObject({ image: true });
    expect(provider.capabilities("some-new-model")).toEqual({
      image: "unknown",
      audio: "unknown",
      video: "unknown",
      pdf: "unknown",
    });
  });
});

it("only sends granted Provider Tools and bounds the profile pin's max_uses", async () => {
  const config = {
    adapter: "anthropic",
    providerOptions: {
      anthropic: {
        serverTools: [
          { type: "web_search_20260318", name: "web_search", max_uses: 9 },
          { type: "web_fetch_20260309", name: "web_fetch" },
        ],
        cache: false,
      },
    },
  };
  expect((await sent({ config, providerOptions: config.providerOptions })).body).not.toHaveProperty("tools");
  expect(
    (
      await sent({
        config,
        providerOptions: config.providerOptions,
        providerTools: { tools: ["web_search"], maxCalls: 2 },
      })
    ).body,
  ).toMatchObject({
    tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 2 }],
  });
});

it("shares a finite call budget across search and fetch", async () => {
  expect((await sent({ providerTools: { tools: ["web_search", "web_fetch"], maxCalls: 3 } })).body).toMatchObject({
    tools: [
      { name: "web_search", max_uses: 2 },
      { name: "web_fetch", max_uses: 1 },
    ],
  });
});
