import { describe, expect, it } from "vitest";
import {
  attachmentsOf,
  chooseCut,
  contextTokens,
  DEFAULT_WINDOW,
  estimateTokens,
  resolveWindow,
} from "../src/compaction.js";
import type { ThreadEvent, ThreadEventData } from "../src/thread-events.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const media = { id: "m1", key: "test/media/t/m1", mimeType: "image/png", bytes: 10 };

/** A log builder: one Turn per `turn()` call, each Step a few events, seqs assigned in order. */
function log() {
  const events: ThreadEvent[] = [];
  let turn = 0;
  let n = 0;
  const push = (data: ThreadEventData) => {
    events.push({ seq: events.length + 1, turn, at: 0, ...data });
    return events.length;
  };
  const api = {
    events,
    /** Starts a Turn with a user message of `chars` characters; returns the `turn.started` seq. */
    turn(chars = 4) {
      turn++;
      n = 0;
      return push({
        type: "turn.started",
        input: { kind: "message", parts: [{ type: "text", text: "x".repeat(chars) }] },
        toolsVersion: "v",
      });
    },
    /** A completed model Step whose reply is `chars` characters and whose usage says `input` prompt tokens. */
    model(chars: number, input: number, calls = 0) {
      push({
        type: "step.started",
        kind: "model",
        n: ++n,
        attempt: 1,
        model: "anthropic/claude-sonnet-5",
        provider: "fake",
        agentVersion: 1,
      });
      push({ type: "message.part", index: 0, block: { type: "text", text: "y".repeat(chars) } });
      for (let i = 0; i < calls; i++)
        push({ type: "message.part", index: i + 1, block: { type: "tool_call", id: `c${i}`, name: "t", input: {} } });
      return push({
        type: "step.completed",
        kind: "model",
        n,
        stopReason: calls > 0 ? "tool_use" : "end_turn",
        usage: { ...usage, input, output: Math.ceil(chars / 4) },
      });
    },
    /** A completed tool Step with one result of `chars` characters; returns the `step.completed` seq. */
    tool(chars: number, withMedia = false) {
      push({ type: "step.started", kind: "tool", n: ++n, attempt: 1, agentVersion: 1 });
      push({
        type: "tool.result",
        id: "c0",
        name: "t",
        content: [{ type: "text", text: "z".repeat(chars) }, ...(withMedia ? [{ type: "media" as const, media }] : [])],
        isError: false,
      });
      return push({ type: "step.completed", kind: "tool", n });
    },
    done() {
      return push({ type: "turn.completed", stopReason: "end_turn", message: [] });
    },
    compacted(firstKeptSeq: number, tokensAfter: number) {
      return push({
        type: "thread.compacted",
        trigger: "auto",
        strategy: "harness",
        firstKeptSeq,
        tokensBefore: 0,
        tokensAfter,
        summary: "s",
        provider: "fake",
        model: "claude-sonnet-5",
        attachments: [],
        usage,
      });
    },
  };
  return api;
}

describe("resolveWindow", () => {
  it("takes the smallest of the Spec's window, the Scope ceiling and the model's own, else the default", () => {
    expect(resolveWindow({})).toBe(DEFAULT_WINDOW);
    expect(resolveWindow({ model: 1_000_000 })).toBe(1_000_000);
    expect(resolveWindow({ spec: 50_000, model: 200_000 })).toBe(50_000);
    expect(resolveWindow({ spec: 50_000, ceiling: 30_000, model: 200_000 })).toBe(30_000);
    expect(resolveWindow({ ceiling: 30_000 })).toBe(30_000);
  });
});

describe("contextTokens", () => {
  it("is the last model Step's prompt and output, plus an estimate of what was logged since", () => {
    const l = log();
    l.turn(40);
    l.model(80, 100, 1);
    l.tool(400);
    // 100 prompt + 20 output from usage, then one 400-char result estimated at ~100 tokens plus JSON overhead.
    const tokens = contextTokens(l.events);
    expect(tokens).toBeGreaterThan(220);
    expect(tokens).toBeLessThan(260);
    l.model(4, 300);
    l.done();
    expect(contextTokens(l.events)).toBe(301);
    l.turn(400);
    expect(contextTokens(l.events)).toBeGreaterThan(400);
  });

  it("restarts from a compaction's tokensAfter", () => {
    const l = log();
    l.turn(40);
    l.model(80, 5000);
    l.done();
    l.compacted(1, 120);
    expect(contextTokens(l.events)).toBe(120);
  });

  it("estimates a fresh Thread from its first input alone", () => {
    const l = log();
    l.turn(400);
    expect(contextTokens(l.events)).toBe(estimateTokens([{ type: "text", text: "x".repeat(400) }]));
  });
});

describe("chooseCut", () => {
  const limits = { window: 1000, reserveTokens: 100, keepRecentTokens: 100 };

  it("keeps whole Turns: walks back to keepRecentTokens, then to that Turn's start", () => {
    const l = log();
    const t1 = l.turn(400);
    l.model(400, 200);
    l.done();
    const t2 = l.turn(400);
    l.model(400, 400);
    l.done();
    const t3 = l.turn(40);
    l.model(40, 600);
    l.done();
    // Turn 3 alone is ~30 tokens, under keepRecent; Turn 2 carries it past 100.
    expect(chooseCut(l.events, limits, 0)).toEqual({ firstKeptSeq: t2, tokensKept: expect.any(Number) });
    expect(chooseCut(l.events, { ...limits, keepRecentTokens: 10 }, 0)?.firstKeptSeq).toBe(t3);
    // When no tail can hold keepRecentTokens without keeping everything, the oldest Turn still goes.
    expect(chooseCut(l.events, { ...limits, keepRecentTokens: 1000 }, 0)?.firstKeptSeq).toBe(t2);
  });

  it("returns nothing when the cut would drop nothing beyond the previous one, or nothing at all", () => {
    const l = log();
    l.turn(400);
    l.model(400, 200);
    l.done();
    const t2 = l.turn(400);
    l.model(400, 200);
    l.done();
    expect(chooseCut(l.events, limits, t2)).toBeUndefined();
    expect(chooseCut(l.events.slice(0, 5), limits, 0)).toBeUndefined();
    expect(chooseCut([], limits, 0)).toBeUndefined();
  });

  it("falls back to a tool Step boundary when the Turn holding keepRecentTokens would still overflow", () => {
    const l = log();
    l.turn(40);
    l.model(40, 100);
    l.done();
    l.turn(40);
    l.model(40, 100, 1);
    const s1 = l.tool(2000);
    l.model(40, 800, 1);
    const s2 = l.tool(2000);
    l.model(40, 1500, 1);
    l.tool(200);
    // The current Turn is ~1100 tokens, over the 900 limit; the cut lands after a tool Step, never inside a batch.
    const cut = chooseCut(l.events, limits, 0);
    expect([s1 + 1, s2 + 1]).toContain(cut?.firstKeptSeq);
    expect(cut?.tokensKept).toBeLessThanOrEqual(900);
    const kept = l.events.filter((e) => e.seq >= cut!.firstKeptSeq);
    expect(kept[0]).toMatchObject({ type: "step.started", kind: "model" });
  });
});

describe("attachmentsOf", () => {
  it("collects the media of the summarised inputs and results once each, prior attachments included", () => {
    const l = log();
    l.events.push({
      seq: 1,
      turn: 0,
      at: 0,
      type: "thread.compacted",
      trigger: "auto",
      strategy: "harness",
      firstKeptSeq: 1,
      tokensBefore: 0,
      tokensAfter: 0,
      summary: "s",
      provider: "fake",
      model: "m",
      attachments: [{ ...media, id: "m0" }],
      usage,
    });
    l.turn(4);
    l.events.push({
      seq: 3,
      turn: 1,
      at: 0,
      type: "turn.input",
      input: { kind: "message", parts: [{ type: "image", media, mimeType: "image/png" }] },
    });
    l.model(4, 10, 1);
    l.tool(4, true);
    expect(attachmentsOf(l.events).map((ref) => ref.id)).toEqual(["m0", "m1"]);
  });
});
