import { expect, it } from "vitest";
import type { ThreadEventData } from "../src/thread-events";
import { interruptedResults } from "../src/tool-step";

const call = (id: string, parentCallId?: string): ThreadEventData => ({
  type: "tool.call",
  id,
  name: parentCallId ? "pack_box" : "run_script",
  input: {},
  ...(parentCallId && { parentCallId }),
});
const result = (id: string, parentCallId?: string): ThreadEventData => ({
  type: "tool.result",
  id,
  name: parentCallId ? "pack_box" : "run_script",
  content: [],
  isError: false,
  ...(parentCallId && { parentCallId }),
});

it("closes each open call, nested calls before their Script, and skips the calls that have a result", () => {
  const events = [
    call("a"),
    result("a"),
    call("script"),
    call("script/1", "t:3"),
    result("script/1", "t:3"),
    call("script/2", "t:3"),
  ].map((event) => ({ event }));
  expect(interruptedResults(events, 2).map((e) => [e.id, e.parentCallId, e.interrupted, e.isError])).toEqual([
    ["script/2", "t:3", { attempt: 2 }, true],
    ["script", undefined, { attempt: 2 }, true],
  ]);
});

it("treats a top-level call id that a later Step uses again as a new call", () => {
  const events = [call("a"), result("a"), call("a")].map((event) => ({ event }));
  expect(interruptedResults(events, 1).map((e) => e.id)).toEqual(["a"]);
  expect(interruptedResults([...events, { event: result("a") }], 1)).toEqual([]);
});
