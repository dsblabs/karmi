import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/index.js";
import { lastMessage, matchers } from "../src/testing/index.js";

const events: ThreadEvent[] = [
  {
    seq: 1,
    turn: 1,
    at: 0,
    type: "turn.started",
    input: { kind: "message", parts: [{ type: "text", text: "hi" }] },
    toolsVersion: "v",
  },
  {
    seq: 2,
    turn: 1,
    at: 0,
    type: "step.started",
    kind: "model",
    n: 1,
    attempt: 1,
    model: "fake/m",
    provider: "fake",
    agentVersion: 1,
  },
  { seq: 3, turn: 1, at: 0, type: "message.part", index: 0, block: { type: "text", text: "partial" } },
  {
    seq: 4,
    turn: 1,
    at: 0,
    type: "step.completed",
    kind: "model",
    n: 1,
    stopReason: "end_turn",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  },
];

describe("test-kit matchers", () => {
  it("toContainEvent matches a partial event deeply", () => {
    expect(matchers.toContainEvent(events, { type: "step.started", model: "fake/m" }).pass).toBe(true);
    expect(
      matchers.toContainEvent(events, {
        type: "step.completed",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }).pass,
    ).toBe(true);
    expect(matchers.toContainEvent(events, { type: "step.started", model: "fake/other" }).pass).toBe(false);
    expect(matchers.toContainEvent(events, { type: "turn.completed" }).message()).toContain("types seen: turn.started");
  });

  it("toHaveSequence accepts gaps but not reordering", () => {
    expect(matchers.toHaveSequence(events, ["turn.started", "step.completed"]).pass).toBe(true);
    expect(matchers.toHaveSequence(events, ["step.completed", "turn.started"]).pass).toBe(false);
    expect(matchers.toHaveSequence(events, ["turn.started", "turn.completed"]).pass).toBe(false);
    expect(events).toHaveSequence(["step.started", "message.part"]);
    expect(events).not.toHaveSequence(["message.part", "step.started"]);
  });

  it("lastMessage falls back to the last text part before the Turn ends", () => {
    expect(lastMessage(events)).toBe("partial");
    expect(
      lastMessage([
        ...events,
        {
          seq: 5,
          turn: 1,
          at: 0,
          type: "turn.completed",
          stopReason: "end_turn",
          message: [{ type: "text", text: "final" }],
        },
      ]),
    ).toBe("final");
    expect(lastMessage([])).toBeUndefined();
  });
});
