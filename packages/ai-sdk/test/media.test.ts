import { expect, it } from "vitest";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { MediaRef, ProviderEvent, ProviderRequest } from "@karmi/core";
import { aiSdk } from "../src/index";

const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const ref: MediaRef = { id: "a", key: "test/media/thread/a", mimeType: "image/png", bytes: 5 };
const data = new TextEncoder().encode("hello").slice().buffer;
function setup(parts: LanguageModelV4StreamPart[] = []) {
  const requests: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unused");
    },
    doStream: async (options) => {
      requests.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [...parts, finish]) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { adapter: aiSdk(() => model), requests };
}
async function collect(stream: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const request: ProviderRequest = { model: "test", config: { adapter: "ai-sdk" }, messages: [] };
const call = { fetch, signal: new AbortController().signal, media: { get: async () => data, put: async () => ref } };

it("optimistically inlines image, PDF, audio and video refs in user and Tool messages", async () => {
  const { adapter, requests } = setup();
  const refs = ["image/png", "application/pdf", "audio/mpeg", "video/mp4", "text/plain"].map((mimeType) => ({
    ...ref,
    mimeType,
  }));
  const events = await collect(
    adapter.stream(
      {
        ...request,
        messages: [
          { role: "user", content: refs.map((media) => ({ type: "media", media })) },
          {
            role: "toolResult",
            toolName: "screen",
            toolCallId: "t",
            isError: false,
            content: [{ type: "media", media: ref }],
          },
        ],
      },
      call,
    ),
  );
  expect(events.some((event) => event.type === "error")).toBe(false);
  expect(requests[0]?.prompt[0]).toMatchObject({
    role: "user",
    content: [
      ...["image/png", "application/pdf", "audio/mpeg", "video/mp4"].map((mediaType) => ({
        type: "file",
        mediaType,
        data: { type: "data", data: "aGVsbG8=" },
      })),
      { type: "text", text: "[file: a, text/plain, 5 bytes — not viewable]" },
    ],
  });
  expect(requests[0]?.prompt[1]).toMatchObject({
    role: "tool",
    content: [{ output: { type: "content", value: [{ type: "file" }] } }],
  });
});

it("stores generated images and nested MCP images before emitting refs, and replays the bytes", async () => {
  const { adapter, requests } = setup([
    { type: "file", mediaType: "image/png", data: { type: "data", data: "aGVsbG8=" } },
    { type: "tool-call", toolCallId: "t", toolName: "screen", input: "{}", providerExecuted: true },
    {
      type: "tool-result",
      toolCallId: "t",
      toolName: "screen",
      result: { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
    },
  ]);
  const events = await collect(adapter.stream(request, call));
  const blocks = events.flatMap((event) => (event.type === "part" ? [event.block] : []));
  expect(blocks[0]).toEqual({ type: "media", media: ref });
  expect(JSON.stringify(blocks)).not.toContain("aGVsbG8=");
  await collect(
    adapter.stream(
      {
        ...request,
        messages: [{ role: "assistant", content: blocks, provider: "ai-sdk", model: "test", stopReason: "end_turn" }],
      },
      call,
    ),
  );
  expect(JSON.stringify(requests[1]?.prompt)).toContain("aGVsbG8=");
});

it("degrades storage failures on input and output without failing the model call", async () => {
  const { adapter, requests } = setup([
    { type: "file", mediaType: "image/png", data: { type: "data", data: "aGVsbG8=" } },
  ]);
  const broken = async () => {
    throw new Error("storage unavailable");
  };
  const events = await collect(
    adapter.stream(
      { ...request, messages: [{ role: "user", content: [{ type: "media", media: ref }] }] },
      { ...call, media: { get: broken, put: broken } },
    ),
  );
  expect(requests[0]?.prompt[0]).toMatchObject({ content: [{ type: "text", text: "[media unavailable]" }] });
  expect(events).toContainEqual({ type: "part", index: 0, block: { type: "text", text: "[media unavailable]" } });
  expect(events.some((event) => event.type === "message.end")).toBe(true);
});

it("downloads URL-backed generated images through scopedFetch before returning a ref", async () => {
  const { adapter } = setup([
    { type: "file", mediaType: "image/png", data: { type: "url", url: new URL("https://images.example/output.png") } },
  ]);
  let downloaded = false;
  let stored = false;
  const events = await collect(
    adapter.stream(request, {
      ...call,
      fetch: async (input) => {
        expect(String(input)).toBe("https://images.example/output.png");
        downloaded = true;
        return new Response("hello");
      },
      media: {
        ...call.media,
        put: async (body) => {
          expect(await new Response(body).text()).toBe("hello");
          stored = true;
          return ref;
        },
      },
    }),
  );
  expect(downloaded).toBe(true);
  expect(stored).toBe(true);
  expect(events).toContainEqual({ type: "part", index: 0, block: { type: "media", media: ref } });
});

it("preserves a generated image’s model metadata across ingress and replay", async () => {
  const metadata = { google: { thoughtSignature: "image-signature" } };
  const { adapter, requests } = setup([
    { type: "file", mediaType: "image/png", data: { type: "data", data: "aGVsbG8=" }, providerMetadata: metadata },
  ]);
  const events = await collect(adapter.stream(request, call));
  const blocks = events.flatMap((event) => (event.type === "part" ? [event.block] : []));
  expect(blocks[0]).toMatchObject({ type: "media", media: ref, providerMetadata: metadata });
  await collect(
    adapter.stream(
      {
        ...request,
        messages: [{ role: "assistant", content: blocks, provider: "ai-sdk", model: "test", stopReason: "end_turn" }],
      },
      call,
    ),
  );
  expect(requests[1]?.prompt[0]).toMatchObject({ content: [{ type: "file", providerOptions: metadata }] });
});
