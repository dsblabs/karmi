import { describe, expect, it } from "vitest";
import type { ThreadEventData } from "../src/thread-events.js";
import { foldTurn } from "../src/turn-state.js";

let seq = 0;
const logged = (event: ThreadEventData) => ({ seq: ++seq, at: 0, event });
const started = (n: number, attempt: number): ThreadEventData => ({
  type: "step.started",
  kind: "compact",
  n,
  attempt,
  model: "anthropic/claude-sonnet-5",
  provider: "fake",
  agentVersion: 1,
  trigger: "overflow",
});

describe("foldTurn with compact Steps", () => {
  it("hands a skipped overflow Compaction back to the model Step it interrupted, re-runs included", () => {
    const events = [
      logged({ type: "turn.started", input: { kind: "message", parts: [] }, toolsVersion: "v" }),
      logged({
        type: "step.started",
        kind: "model",
        n: 1,
        attempt: 1,
        model: "anthropic/claude-sonnet-5",
        provider: "fake",
        agentVersion: 1,
      }),
      logged(started(2, 1)),
    ];
    expect(foldTurn(events, 0).plan).toEqual({ kind: "compact", n: 2, trigger: "overflow" });
    // An eviction re-runs the compact Step; when that run is called off, the model Step is still the one to retry.
    events.push(logged(started(2, 2)), logged({ type: "step.completed", kind: "compact", n: 2 }));
    const state = foldTurn(events, 0);
    expect(state.plan).toEqual({ kind: "model", n: 1, fresh: false });
    expect(state.compaction).toBe("skipped");
    expect(state.lastStep).toBe(2);
  });
});
