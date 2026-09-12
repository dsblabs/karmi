import { expect, it } from "vitest";
import { anthropic } from "../src/index";
import { collect, request, serve } from "./helpers";
import text from "./fixtures/text.sse?raw";
import type { MediaRef } from "@karmi/core";

const ref: MediaRef = {
  id: "a",
  key: "test/media/thread/a",
  mimeType: "application/pdf",
  bytes: 9,
  name: "report.pdf",
};
const data = new TextEncoder().encode("%PDF-1.7\n").slice().buffer;
const media = { get: async () => data, put: async () => ref };

it("inlines PDFs in messages and Tool results, and degrades missing, unsupported and oversize refs", async () => {
  const transport = serve({ sse: text });
  const image = { ...ref, mimeType: "image/png" };
  const file = { ...ref, mimeType: "text/plain", name: "notes.txt" };
  const audio = { ...ref, mimeType: "audio/mpeg" };
  const large = { ...image, bytes: 50_000_000 };
  const missing = { ...image, key: "missing" };
  const events = await collect(
    anthropic({ apiKey: "test" }),
    request({
      messages: [
        { role: "user", content: [ref, image, file, audio, large, missing].map((media) => ({ type: "media", media })) },
        {
          role: "toolResult",
          toolName: "test",
          toolCallId: "tool-1",
          isError: false,
          content: [{ type: "media", media: ref }],
        },
      ],
    }),
    { ...transport, media: { ...media, get: async (ref) => (ref.key === "missing" ? undefined : data) } },
  );
  expect(events.some((event) => event.type === "error")).toBe(false);
  const body = JSON.stringify(transport.calls[0]?.body);
  expect(body).toContain("JVBERi0xLjcK");
  expect(body).toContain('"type":"document"');
  expect(body).toContain('"type":"image"');
  expect(body).toContain("[file: notes.txt, text/plain, 9 bytes — not viewable]");
  expect(body).toContain("[audio dropped:");
  expect(body).toContain("[image dropped:");
  expect(body).toContain("[media unavailable]");
});

it("spills native MCP images and restores them on the next request without storing base64", async () => {
  const sse = [
    {
      type: "message_start",
      message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "mcp_tool_use", id: "tool-1", name: "screen", server_name: "remote", input: {} },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "mcp_tool_result",
        tool_use_id: "tool-1",
        is_error: false,
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
      },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const transport = serve({ sse }, { sse: text });
  const stored: ArrayBuffer[] = [];
  const image = { ...ref, mimeType: "image/png", bytes: 5 };
  const access = {
    get: async () => new TextEncoder().encode("hello").slice().buffer,
    put: async (body: unknown) => {
      if (body instanceof ArrayBuffer) stored.push(body);
      return image;
    },
  };
  const adapter = anthropic({ apiKey: "test" });
  const events = await collect(adapter, request(), { ...transport, media: access });
  const blocks = events.flatMap((event) => (event.type === "part" ? [event.block] : []));
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(blocks)).not.toContain("aGVsbG8=");
  expect(JSON.stringify(blocks)).toContain(image.key);
  await collect(
    adapter,
    request({
      messages: [
        { role: "assistant", content: blocks, provider: "anthropic", model: "claude-sonnet-5", stopReason: "end_turn" },
      ],
    }),
    { ...transport, media: access },
  );
  expect(JSON.stringify(transport.calls[1]?.body)).toContain("aGVsbG8=");
});

it("tries unknown model modalities optimistically instead of stripping the attachment", async () => {
  const transport = serve({ sse: text });
  await collect(
    anthropic({ apiKey: "test" }),
    request({
      model: "new-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "media", media: { ...ref, mimeType: "audio/mpeg" } },
            { type: "media", media: { ...ref, mimeType: "video/mp4" } },
          ],
        },
      ],
    }),
    { ...transport, media },
  );
  const body = JSON.stringify(transport.calls[0]?.body);
  expect(body).toContain('"type":"audio"');
  expect(body).toContain('"type":"video"');
  expect(body).toContain("JVBERi0xLjcK");
});
