import { describe, expect, it } from "vitest";
import { transcriptFromEvents } from "../src/transcript.js";
import type { ThreadEvent, ThreadEventData } from "../src/thread-events.js";

let seq = 0;
const ev = (turn: number, data: ThreadEventData): ThreadEvent => ({ seq: ++seq, turn, at: 0, ...data });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("transcriptFromEvents", () => {
  it("turns a message Turn into a user message and the completed model Step into an assistant message", () => {
    const events = [
      ev(1, {
        type: "turn.started",
        input: { kind: "message", parts: [{ type: "text", text: "hi" }] },
        toolsVersion: "v",
      }),
      ev(1, {
        type: "step.started",
        kind: "model",
        n: 1,
        attempt: 1,
        model: "anthropic/claude-sonnet-5",
        provider: "anthropic",
        agentVersion: 1,
      }),
      ev(1, { type: "message.delta", index: 0, kind: "text", text: "Hel" }),
      ev(1, { type: "message.part", index: 0, block: { type: "text", text: "Hello" } }),
      ev(1, { type: "step.completed", kind: "model", n: 1, stopReason: "end_turn", usage }),
      ev(1, { type: "turn.completed", stopReason: "end_turn", message: [{ type: "text", text: "Hello" }] }),
    ];
    expect(transcriptFromEvents(events)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
      },
    ]);
  });

  it("keeps only the attempt of a Step that completed, so a failed fallback leaves no half message", () => {
    const events = [
      ev(1, {
        type: "turn.started",
        input: { kind: "message", parts: [{ type: "text", text: "hi" }] },
        toolsVersion: "v",
      }),
      ev(1, {
        type: "step.started",
        kind: "model",
        n: 1,
        attempt: 1,
        model: "anthropic/a",
        provider: "anthropic",
        agentVersion: 1,
      }),
      ev(1, { type: "message.part", index: 0, block: { type: "text", text: "partial" } }),
      ev(1, {
        type: "step.started",
        kind: "model",
        n: 1,
        attempt: 2,
        model: "anthropic/b",
        provider: "anthropic",
        agentVersion: 1,
      }),
      ev(1, { type: "message.part", index: 0, block: { type: "text", text: "whole" } }),
      ev(1, { type: "step.completed", kind: "model", n: 1, stopReason: "end_turn", usage }),
      ev(2, {
        type: "turn.started",
        input: { kind: "message", parts: [{ type: "text", text: "again" }] },
        toolsVersion: "v",
      }),
      ev(2, {
        type: "step.started",
        kind: "model",
        n: 1,
        attempt: 1,
        model: "anthropic/b",
        provider: "anthropic",
        agentVersion: 1,
      }),
      ev(2, { type: "message.part", index: 0, block: { type: "text", text: "in flight" } }),
    ];
    expect(transcriptFromEvents(events)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "whole" }],
        provider: "anthropic",
        model: "b",
        stopReason: "end_turn",
      },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
  });

  it("shows an Event input through the Event Fragment and media Parts as media blocks", () => {
    const media = { id: "m1", key: "s/media/t/m1", mimeType: "image/png", bytes: 3 };
    const events = [
      ev(1, {
        type: "turn.started",
        input: { kind: "event", type: "shop.order_paid", payload: { orderId: 7 } },
        toolsVersion: "v",
      }),
      ev(2, {
        type: "turn.started",
        input: {
          kind: "message",
          parts: [
            { type: "image", media, mimeType: "image/png" },
            { type: "text", text: "what is this?" },
          ],
        },
        toolsVersion: "v",
      }),
    ];
    expect(transcriptFromEvents(events)).toEqual([
      { role: "user", content: [{ type: "text", text: 'Event "shop.order_paid":\n{"orderId":7}' }] },
      {
        role: "user",
        content: [
          { type: "media", media },
          { type: "text", text: "what is this?" },
        ],
      },
    ]);
  });
});
