import { describe, expect, it } from "vitest";
import { normalizeToolCallId, prepareMessages, type ContentBlock, type Message, type StopReason } from "../src/index";

const claude = { provider: "anthropic", model: "claude-sonnet-5" };
const gpt = { provider: "openai", model: "gpt-5" };

const assistant = (content: ContentBlock[], from = claude, stopReason: StopReason = "end_turn"): Message => ({
  role: "assistant",
  ...from,
  content,
  stopReason,
});
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const result = (toolCallId: string, text = "ok"): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "weather",
  content: [{ type: "text", text }],
  isError: false,
});
const call = (id: string): ContentBlock => ({ type: "tool_call", id, name: "weather", input: { city: "Oslo" } });

describe("prepareMessages", () => {
  describe("thinking retention", () => {
    const signed = assistant([
      { type: "thinking", text: "let me see", signature: "sig" },
      { type: "text", text: "Hi" },
    ]);
    const redacted = assistant([
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "Hi" },
    ]);
    const unsigned = assistant([
      { type: "thinking", text: "let me see" },
      { type: "text", text: "Hi" },
    ]);

    it("keeps signed and redacted thinking for the same model", () => {
      expect(prepareMessages([user("q"), signed], claude).messages[1]).toEqual(signed);
      expect(prepareMessages([user("q"), redacted], claude).messages[1]).toEqual(redacted);
    });

    it("turns thinking into text for another model and drops what cannot be read", () => {
      expect(prepareMessages([user("q"), signed], gpt).messages[1]).toMatchObject({
        content: [
          { type: "text", text: "let me see" },
          { type: "text", text: "Hi" },
        ],
      });
      expect(prepareMessages([user("q"), redacted], gpt).messages[1]).toMatchObject({
        content: [{ type: "text", text: "Hi" }],
      });
      expect(prepareMessages([user("q"), unsigned], { ...claude, model: "claude-opus-5" }).messages[1]).toMatchObject({
        content: [
          { type: "text", text: "let me see" },
          { type: "text", text: "Hi" },
        ],
      });
    });

    it("drops empty unsigned thinking even for the same model", () => {
      const empty = assistant([
        { type: "thinking", text: "  " },
        { type: "text", text: "Hi" },
      ]);
      expect(prepareMessages([user("q"), empty], claude).messages[1]).toMatchObject({
        content: [{ type: "text", text: "Hi" }],
      });
    });
  });

  describe("tool-call ids", () => {
    it("leaves portable ids alone and rewrites the rest consistently in calls and results", () => {
      const wild = "fc|0123456789|" + "x".repeat(500);
      const messages = prepareMessages([user("q"), assistant([call(wild)], gpt), result(wild)], claude).messages;
      const id = (messages[1] as { content: { id: string }[] }).content[0]!.id;
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(id).toBe(normalizeToolCallId(wild));
      expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: id });
      expect(messages).toHaveLength(3);
    });

    it("keeps long ids distinct", () => {
      const a = "a".repeat(100) + "1";
      const b = "a".repeat(100) + "2";
      expect(normalizeToolCallId(a)).not.toBe(normalizeToolCallId(b));
      expect(normalizeToolCallId("toolu_01")).toBe("toolu_01");
      expect(normalizeToolCallId("")).toBe("call");
    });

    it("keeps a thought signature only for the same model", () => {
      const gemini = { provider: "google", model: "gemini-3" };
      const signed = assistant(
        [{ type: "tool_call", id: "c1", name: "weather", input: { city: "Oslo" }, signature: "thought" }],
        gemini,
      );
      expect(prepareMessages([user("q"), signed, result("c1")], gemini).messages[1]).toEqual(signed);
      expect(
        (prepareMessages([user("q"), signed, result("c1")], claude).messages[1] as { content: object[] }).content[0],
      ).toEqual(call("c1"));
    });
  });

  describe("orphaned tool calls", () => {
    it("synthesises an error result for every call without one, before the next message", () => {
      const messages = prepareMessages(
        [user("q"), assistant([call("c1"), call("c2")]), result("c2"), user("next")],
        claude,
      ).messages;
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
      expect(messages[3]).toEqual({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "weather",
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
      });
    });

    it("repairs a transcript that ends mid-batch", () => {
      const messages = prepareMessages([user("q"), assistant([call("c1")])], claude).messages;
      expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
    });

    it("drops errored and aborted assistant messages so the model retries from the last good state", () => {
      const messages = prepareMessages(
        [
          user("q"),
          assistant([{ type: "text", text: "partial" }], claude, "aborted"),
          assistant([call("c1")], claude, "error"),
          user("again"),
        ],
        claude,
      ).messages;
      expect(messages).toEqual([user("q"), user("again")]);
    });

    it("drops results whose call went with a dropped assistant message", () => {
      const messages = prepareMessages(
        [user("q"), assistant([call("c1")], claude, "error"), result("c1"), user("again")],
        claude,
      ).messages;
      expect(messages).toEqual([user("q"), user("again")]);
    });
  });

  describe("system placement", () => {
    it("hoists leading system messages into the request system and merges neighbours", () => {
      const prepared = prepareMessages(
        [
          { role: "system", content: "A" },
          { role: "system", content: "B" },
          user("q"),
          assistant([{ type: "text", text: "Hi" }]),
          { role: "system", content: "C" },
          { role: "system", content: "D" },
          user("more"),
        ],
        claude,
      );
      expect(prepared.system).toBe("A\n\nB");
      expect(prepared.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
      expect(prepared.messages[2]).toEqual({ role: "system", content: "C\n\nD" });
    });

    it("never splits a tool call from its results", () => {
      const prepared = prepareMessages(
        [user("q"), assistant([call("c1")]), { role: "system", content: "steer" }, result("c1"), user("more")],
        claude,
      );
      expect(prepared.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "system", "user"]);
      expect(prepared.system).toBeUndefined();
    });
  });

  describe("provider-opaque blocks", () => {
    const search: Message = assistant([
      {
        type: "server_tool",
        id: "s1",
        name: "web_search",
        input: { q: "x" },
        result: { raw: { encrypted: "…" }, summary: "3 results about x" },
      },
      { type: "text", text: "Found it" },
    ]);
    const compacted: Message = assistant([
      { type: "compaction", summary: "Earlier we discussed x.", raw: { type: "compaction", content: "…" } },
    ]);
    const foreign: Message = assistant([
      { type: "provider", raw: { type: "fallback" } },
      { type: "text", text: "Hi" },
    ]);

    it("replays them byte-exact to the same provider, even on another model", () => {
      const other = { ...claude, model: "claude-opus-5" };
      expect(prepareMessages([user("q"), search, compacted, foreign], other).messages.slice(1)).toEqual([
        search,
        compacted,
        foreign,
      ]);
    });

    it("hands another provider the summaries and drops what has none", () => {
      const [, a, b, c] = prepareMessages([user("q"), search, compacted, foreign], gpt).messages;
      expect(a).toMatchObject({
        content: [
          { type: "text", text: "3 results about x" },
          { type: "text", text: "Found it" },
        ],
      });
      expect(b).toMatchObject({ content: [{ type: "text", text: "Earlier we discussed x." }] });
      expect(c).toMatchObject({ content: [{ type: "text", text: "Hi" }] });
    });
  });

  it("passes text, media and tool results through untouched and stays JSON-serialisable", () => {
    const messages: Message[] = [
      user("q"),
      {
        role: "user",
        content: [{ type: "media", media: { id: "m1", key: "s/media/t/m1", mimeType: "image/png", bytes: 10 } }],
      },
      assistant([call("c1")]),
      result("c1"),
    ];
    const prepared = prepareMessages(messages, claude);
    expect(prepared.messages).toEqual(messages);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
  });
});

it("keeps provider metadata only when replaying to the same model", () => {
  const block: ContentBlock = { type: "text", text: "Hello", providerMetadata: { openai: { itemId: "opaque" } } };
  const message = assistant([block], gpt);
  expect(prepareMessages([message], gpt).messages).toEqual([message]);
  expect(prepareMessages([message], { ...gpt, model: "another-model" }).messages).toEqual([
    assistant([{ type: "text", text: "Hello" }], gpt),
  ]);
  expect(prepareMessages([message], claude).messages).toEqual([assistant([{ type: "text", text: "Hello" }], gpt)]);
  expect(block.providerMetadata).toEqual({ openai: { itemId: "opaque" } });
});

it("retains compaction and provider-tool metadata across models of the same provider", () => {
  const compaction: ContentBlock = {
    type: "compaction",
    summary: "Summary",
    raw: { type: "text", text: "Summary" },
    providerMetadata: { anthropic: { type: "compaction" } },
  };
  const serverTool: ContentBlock = {
    type: "server_tool",
    id: "mcp",
    name: "search",
    input: {},
    providerMetadata: { anthropic: { type: "mcp-tool-use", serverName: "docs" } },
  };
  const message = assistant([compaction, serverTool]);
  expect(prepareMessages([message], { ...claude, model: "another-model" }).messages).toEqual([message]);
});
