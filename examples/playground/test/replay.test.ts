import type { ContentBlock, ProviderEvent } from "@karmi/core";
import { fakeProvider, lastMessage, type RecordingEntry } from "@karmi/core/testing";
import { describe, expect, it } from "vitest";
import { FRONT_DESK, frontDeskAgent, frontDeskRecording } from "../src/transports";
import recording from "./recordings/front-desk.jsonl?raw";
import { provider, scope } from "./worker";

// The replay step of the operations walkthrough. `pnpm record` replaces the recording with real calls of the front
// desk Agent. This test then sends each recorded prompt again and expects the recorded answer.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The test reads each line of the recording through this function. It checks only what the test uses.
function decodeEntry(line: string): RecordingEntry {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || !isRecord(value.request) || !Array.isArray(value.events))
    throw new Error("Not a recording entry.");
  const entry: unknown = value;
  return entry as RecordingEntry;
}

const entries = recording
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map(decodeEntry);

const textOf = (blocks: readonly ContentBlock[]) =>
  blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** The text of the last message of the operator in a recorded request. */
function promptOf({ request }: RecordingEntry): string {
  const message = request.messages.findLast((item) => item.role === "user");
  return message?.role === "user" ? textOf(message.content) : "";
}

/** The text that the Provider answered in a recorded call. */
const answerOf = ({ events }: RecordingEntry) =>
  textOf(events.flatMap((event) => (event.type === "part" ? [event.block] : [])));

describe("the recording of the front desk Agent", () => {
  it("replays each recorded Turn with the recorded answer and no model call", async () => {
    expect(entries.length).toBeGreaterThan(0);
    const replay = fakeProvider.fromRecording(recording);
    // The test Worker has one scripted Provider. It streams what the replay Provider streams for the same request.
    provider.script(async ({ request, options }) => {
      const events: ProviderEvent[] = [];
      for await (const event of replay.stream(request, options)) events.push(event);
      return events;
    });
    const thread = scope.thread({ agent: FRONT_DESK, user: "operator", threadId: `replay-${crypto.randomUUID()}` });
    for (const entry of entries) {
      const events = await thread.send({ kind: "message", parts: [{ type: "text", text: promptOf(entry) }] });
      expect(events).toContainEvent({ type: "turn.completed" });
      expect(lastMessage(events)).toBe(answerOf(entry));
    }
    expect(replay.requests).toHaveLength(entries.length);
  });

  it("keeps only the calls of the front desk Agent when the Worker records", () => {
    const [instructions] = frontDeskAgent("fake/model").spec.instructions;
    const call = (system: string): RecordingEntry => ({
      request: { model: "model", config: { adapter: "playground" }, system, messages: [] },
      events: [],
    });
    const front = call(instructions && "text" in instructions ? instructions.text : "");
    const lines = frontDeskRecording([call("You work at the refund desk."), front]);
    expect(lines.split("\n").filter(Boolean).map(decodeEntry)).toEqual([front]);
  });
});
