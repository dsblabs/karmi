import { describe, expect, it } from "vitest";
import { anthropic } from "../src/index";
import compaction from "./fixtures/compaction.sse?raw";
import contextWindow from "./fixtures/context-window.sse?raw";
import fallback from "./fixtures/fallback.sse?raw";
import mcp from "./fixtures/mcp.sse?raw";
import refusal from "./fixtures/refusal.sse?raw";
import serverTool from "./fixtures/server-tool.sse?raw";
import text from "./fixtures/text.sse?raw";
import thinking from "./fixtures/thinking.sse?raw";
import toolSearch from "./fixtures/tool-search.sse?raw";
import toolUse from "./fixtures/tool-use.sse?raw";
import truncated from "./fixtures/truncated.sse?raw";
import streamError from "./fixtures/stream-error.sse?raw";
import { collect, request, serve } from "./helpers";

const provider = anthropic({ apiKey: "sk-test" });
const parts = (events: Awaited<ReturnType<typeof collect>>) =>
  events.flatMap((event) => (event.type === "part" ? [event] : []));
const end = (events: Awaited<ReturnType<typeof collect>>) => events.find((event) => event.type === "message.end");

describe("stream mapping", () => {
  it("streams text as deltas then a part, with cumulative usage including the 1h cache split", async () => {
    const events = await collect(provider, request(), serve({ sse: text }));
    expect(events).toEqual([
      { type: "message.start", model: "claude-sonnet-5", responseId: "msg_01" },
      { type: "delta", index: 0, kind: "text", text: "Hello" },
      { type: "delta", index: 0, kind: "text", text: ", world" },
      { type: "part", index: 0, block: { type: "text", text: "Hello, world" } },
      {
        type: "message.end",
        stopReason: "end_turn",
        usage: { input: 25, output: 7, cacheRead: 100, cacheWrite: 12, cacheWrite1h: 8 },
      },
    ]);
  });

  it("carries adaptive thinking with its signature, redacted thinking, and reasoning tokens", async () => {
    const events = await collect(provider, request(), serve({ sse: thinking }));
    expect(events.filter((event) => event.type === "delta")).toEqual([
      { type: "delta", index: 0, kind: "thinking", text: "Let me " },
      { type: "delta", index: 0, kind: "thinking", text: "think." },
      { type: "delta", index: 2, kind: "text", text: "Done" },
    ]);
    expect(parts(events)).toEqual([
      { type: "part", index: 0, block: { type: "thinking", text: "Let me think.", signature: "sig_abc" } },
      { type: "part", index: 1, block: { type: "thinking", text: "", signature: "REDACTED_BLOB", redacted: true } },
      { type: "part", index: 2, block: { type: "text", text: "Done" } },
    ]);
    expect(end(events)).toMatchObject({ usage: { output: 40, reasoning: 30 } });
  });

  it("assembles tool_use input from partial JSON and stops with tool_use", async () => {
    const events = await collect(provider, request(), serve({ sse: toolUse }));
    expect(events.filter((event) => event.type === "delta" && event.kind === "tool_input")).toEqual([
      { type: "delta", index: 1, kind: "tool_input", text: '{"city": ' },
      { type: "delta", index: 1, kind: "tool_input", text: '"Oslo"}' },
    ]);
    expect(parts(events).slice(1)).toEqual([
      {
        type: "part",
        index: 1,
        block: { type: "tool_call", id: "toolu_01", name: "weather", input: { city: "Oslo" } },
      },
      { type: "part", index: 2, block: { type: "tool_call", id: "toolu_02", name: "lookup", input: {} } },
    ]);
    expect(end(events)).toMatchObject({ stopReason: "tool_use" });
  });

  it("joins a server tool call and its byte-exact result into one server_tool part and counts the call", async () => {
    const events = await collect(provider, request(), serve({ sse: serverTool }));
    const raw = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_01",
      content: [
        {
          type: "web_search_result",
          title: "karmi",
          url: "https://example.com/karmi",
          encrypted_content: "ENC1",
          page_age: null,
        },
      ],
    };
    expect(parts(events)).toEqual([
      {
        type: "part",
        index: 0,
        block: {
          type: "server_tool",
          id: "srvtoolu_01",
          name: "web_search",
          input: { query: "karmi framework" },
          raw: { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "karmi framework" } },
          result: { raw, summary: "karmi — https://example.com/karmi" },
        },
      },
      { type: "part", index: 2, block: { type: "text", text: "Found it." } },
    ]);
    expect(end(events)).toMatchObject({ usage: { serverToolCalls: 1 } });
  });

  it("carries tool_search results with their tool_reference blocks byte-exact, then the deferred tool call", async () => {
    const events = await collect(provider, request(), serve({ sse: toolSearch }));
    expect(parts(events)).toEqual([
      {
        type: "part",
        index: 0,
        block: {
          type: "server_tool",
          id: "srvtoolu_02",
          name: "tool_search_tool_regex",
          input: { query: "weather" },
          raw: {
            type: "server_tool_use",
            id: "srvtoolu_02",
            name: "tool_search_tool_regex",
            input: { query: "weather" },
          },
          result: {
            raw: {
              type: "tool_search_tool_result",
              tool_use_id: "srvtoolu_02",
              content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
              },
            },
            summary: expect.any(String),
          },
        },
      },
      {
        type: "part",
        index: 2,
        block: { type: "tool_call", id: "toolu_03", name: "get_weather", input: { city: "Oslo" } },
      },
    ]);
  });

  it("lands a compaction block as karmi's compaction part with the raw block for replay", async () => {
    const events = await collect(provider, request(), serve({ sse: compaction }));
    expect(parts(events)[0]).toEqual({
      type: "part",
      index: 0,
      block: {
        type: "compaction",
        summary: "The user asked about the weather.",
        raw: { type: "compaction", content: "The user asked about the weather.", encrypted_content: "ENC_SUMMARY" },
      },
    });
    expect(events.some((event) => event.type === "delta" && event.index === 0)).toBe(false);
  });

  it("reports the served model on a fallback, logs the hop and keeps the fallback block as a provider part", async () => {
    const hops: unknown[] = [];
    const logger = {
      debug() {},
      info: (message: string, fields?: unknown) => void hops.push([message, fields]),
      warn() {},
      error() {},
    };
    const events = await collect(provider, request(), { fetch: serve({ sse: fallback }).fetch, logger });
    expect(events[0]).toEqual({ type: "message.start", model: "claude-haiku-4-5", responseId: "msg_01" });
    expect(parts(events)[0]).toEqual({
      type: "part",
      index: 0,
      block: {
        type: "provider",
        raw: {
          type: "fallback",
          from: { model: "claude-sonnet-5" },
          to: { model: "claude-haiku-4-5" },
          trigger: { type: "refusal", stop_details: { type: "refusal", reason: "classifier" } },
        },
      },
    });
    expect(hops).toEqual([
      [
        "provider fallback",
        {
          from: "claude-sonnet-5",
          to: "claude-haiku-4-5",
          trigger: { type: "refusal", stop_details: { type: "refusal", reason: "classifier" } },
        },
      ],
    ]);
  });

  it("keeps MCP connector blocks as provider parts, with the call's streamed input filled in", async () => {
    const events = await collect(provider, request(), serve({ sse: mcp }));
    expect(parts(events)).toEqual([
      {
        type: "part",
        index: 0,
        block: {
          type: "provider",
          raw: { type: "mcp_tool_use", id: "mcptoolu_01", name: "echo", server_name: "demo", input: { text: "hi" } },
        },
      },
      {
        type: "part",
        index: 1,
        block: {
          type: "provider",
          raw: {
            type: "mcp_tool_result",
            tool_use_id: "mcptoolu_01",
            is_error: false,
            content: [{ type: "text", text: "hi", citations: null }],
          },
        },
      },
      { type: "part", index: 2, block: { type: "text", text: "Echoed." } },
    ]);
  });

  it("maps refusal with its stop_details and model_context_window_exceeded", async () => {
    expect(end(await collect(provider, request(), serve({ sse: refusal })))).toEqual({
      type: "message.end",
      stopReason: "refusal",
      stopDetails: { type: "refusal", reason: "classifier", fallback_credit_token: "tok_1" },
      usage: { input: 25, output: 1, cacheRead: 100, cacheWrite: 12, cacheWrite1h: 8 },
    });
    expect(end(await collect(provider, request(), serve({ sse: contextWindow })))).toMatchObject({
      stopReason: "context_window_exceeded",
    });
  });

  it("ends a stream cut before message_stop with a retryable network error", async () => {
    const events = await collect(provider, request(), serve({ sse: truncated }));
    expect(events.at(-1)).toEqual({
      type: "error",
      error: { code: "network", message: "The stream ended before message_stop.", retryable: true },
    });
  });

  it("classifies a mid-stream error event by its Anthropic type, keeping what streamed before it", async () => {
    const events = await collect(provider, request(), serve({ sse: streamError }));
    expect(parts(events)).toEqual([{ type: "part", index: 0, block: { type: "text", text: "Partial" } }]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "unavailable", message: "Overloaded", retryable: true },
    });
  });

  it("passes every SSE event through as raw when asked", async () => {
    const events = await collect(
      provider,
      request({ providerOptions: { anthropic: { raw: true } } }),
      serve({ sse: text }),
    );
    expect(
      events.filter((event) => event.type === "raw").map((event) => (event as { raw: { type: string } }).raw.type),
    ).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("ends with an aborted error when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(provider, request(), { fetch: serve({ sse: text }).fetch, signal: controller.signal });
    expect(events).toEqual([
      { type: "error", error: { code: "aborted", message: "The call was aborted.", retryable: false } },
    ]);
  });
});
