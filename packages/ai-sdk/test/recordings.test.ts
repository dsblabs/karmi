import { expect, it } from "vitest";
import type { ProviderEvent } from "@karmi/core";
import { aiSdk } from "../src/index.js";
import { recordings } from "./fixtures/recordings.js";

it.each(recordings)("replays the recorded $name doStream parts", async ({ provider, parts }) => {
  const adapter = aiSdk(() => ({
    specificationVersion: "v4",
    provider,
    modelId: "test",
    supportedUrls: {},
    doGenerate() {
      throw new Error("Only doStream is allowed");
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  }));
  const events: ProviderEvent[] = [];
  for await (const event of adapter.stream(
    { model: "test", config: { adapter: "ai-sdk" }, messages: [] },
    { fetch, signal: new AbortController().signal },
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
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
});
