import { beforeEach, describe, expect, it } from "vitest";
import { lastMessage, reply } from "../src/testing/index.js";
import { provider, scope, trace } from "./worker.js";

let n = 0;
const fresh = (agent = "concierge") => scope.thread({ agent, user: "guest-1", threadId: `tool-${++n}` });
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });

beforeEach(() => {
  trace.length = 0;
});

describe("tool Step", () => {
  it("runs a read-only batch in parallel as one tool Step, then calls the model again with the results", async () => {
    provider.script([[reply.toolCall("lookup", { id: "a" }, "c1"), reply.toolCall("lookup", { id: "b" }, "c2")], "Both found"]);
    const events = await fresh().send(message("Find a and b"));
    expect(events).toHaveSequence(["step.started", "step.completed", "step.started", "tool.call", "tool.call", "tool.result", "tool.result", "step.completed", "step.started", "step.completed", "turn.completed"]);
    expect(events).toContainEvent({ type: "step.started", kind: "tool", n: 2, attempt: 1 });
    expect(events).toContainEvent({ type: "tool.call", id: "c1", name: "lookup", input: { id: "a" } });
    expect(events).toContainEvent({ type: "tool.result", id: "c1", name: "lookup", content: [{ type: "text", text: "Guest a" }], isError: false });
    expect(events).toContainEvent({ type: "step.completed", kind: "tool", n: 2 });
    expect(events).toContainEvent({ type: "step.started", kind: "model", n: 3 });
    expect(lastMessage(events)).toBe("Both found");
    expect(trace).toEqual(["before-turn:1:message", "lookup:start:a", "lookup:start:b", "lookup:end:a", "after-tool:lookup:ok", "lookup:end:b", "after-tool:lookup:ok", "after-turn:1:turn.completed"]);

    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["weather", "lookup", "book", "big_output", "failing", "read_output"]);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Find a and b" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "lookup", input: { id: "a" } }, { type: "tool_call", id: "c2", name: "lookup", input: { id: "b" } }], provider: "fake", model: "claude-sonnet-5", stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: [{ type: "text", text: "Guest a" }], isError: false },
      { role: "toolResult", toolCallId: "c2", toolName: "lookup", content: [{ type: "text", text: "Guest b" }], isError: false },
    ]);
  });
});

describe("batch sequencing", () => {
  it("runs a mutating Tool alone, before and after read-only calls of the same batch", async () => {
    provider.script([[reply.toolCall("lookup", { id: "a" }, "c1"), reply.toolCall("book", { room: 7 }, "c2"), reply.toolCall("lookup", { id: "b" }, "c3"), reply.toolCall("book", { room: 8 }, "c4")], "Done"]);
    const events = await fresh().send(message("Book"));
    expect(trace.filter((entry) => !entry.startsWith("after-") && !entry.startsWith("before-"))).toEqual(["lookup:start:a", "lookup:end:a", "book:start:7", "book:end:7", "lookup:start:b", "lookup:end:b", "book:start:8", "book:end:8"]);
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(4);
    expect(events).toContainEvent({ type: "tool.result", id: "c2", content: [{ type: "text", text: "Booked 7" }], isError: false });
  });
});

describe("Permission Policy", () => {
  it("never offers a denied Tool and answers a call to it with an isError result, without running it", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1"), reply.toolCall("weather", { city: "Rome" }, "c2")], "Sorry"]);
    const events = await fresh("guarded").send(message("Book room 1"));
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["weather", "lookup", "whoami", "read_output"]);
    expect(events).toContainEvent({ type: "tool.call", id: "c1", name: "book" });
    expect(events).toContainEvent({ type: "tool.result", id: "c1", name: "book", isError: true, content: [{ type: "text", text: 'Tool "book" is denied by the Permission Policy.' }] });
    expect(trace).toEqual([]);
    expect(provider.requests[1]?.messages.at(-2)).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
  });

  it("answers an ask with an isError result until Approvals exist", async () => {
    provider.script([[reply.toolCall("book", { room: 1 }, "c1")], "Ok"]);
    const events = await fresh("asking").send(message("Book"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: true, content: [{ type: "text", text: 'Tool "book" requires approval, which this Agent cannot request yet.' }] });
    expect(trace).toEqual([]);
  });
});

describe("Hooks", () => {
  it("lets a before-tool Hook rewrite the input, logging what the Tool actually ran with", async () => {
    provider.script([[reply.toolCall("weather", { city: "Rome" }, "c1")], "Sunny"]);
    const events = await fresh("guarded").send(message("Weather?"));
    expect(events).toContainEvent({ type: "tool.call", id: "c1", name: "weather", input: { city: "Paris" } });
    expect(events).toContainEvent({ type: "tool.result", id: "c1", content: [{ type: "text", text: "Sunny in Paris" }], isError: false });
  });

  it("lets a before-tool Hook deny a call the Policy allowed", async () => {
    provider.script([[reply.toolCall("lookup", { id: "x" }, "c1")], "Hm"]);
    const events = await fresh("hooked").send(message("Look up x"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: true, content: [{ type: "text", text: 'Tool "lookup" was refused by a Hook: Not now' }] });
    expect(trace).toEqual([]);
  });

  it("dispatches before-turn, after-tool, after-turn and on-error by name with the Turn's context", async () => {
    provider.script([[reply.toolCall("failing", {}, "c1")], [reply.error({ code: "unavailable" })], [reply.error({ code: "unavailable" })]]);
    const events = await fresh().send(message("Fail"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", name: "failing", isError: true, content: [{ type: "text", text: "boom" }] });
    expect(events).toContainEvent({ type: "turn.failed", reason: "provider" });
    expect(trace).toEqual(["before-turn:1:message", "after-tool:failing:error", "on-error:provider", "after-turn:1:turn.failed"]);
  });
});

describe("Tool context", () => {
  it("carries callId, attempt, validated settings and the agent-level Connection", async () => {
    await scope.agents.connections.set("guarded", "crm", { token: "t-1" });
    provider.script([[reply.toolCall("whoami", {}, "c1")], "You are you"]);
    const thread = fresh("guarded");
    const events = await thread.send(message("Who am I?"));
    const call = events.find((e) => e.type === "tool.call")!;
    const result = events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ isError: false });
    const seen = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
    expect(seen).toEqual({ scope: "test", user: "guest-1", thread: { id: `tool-${n}` }, settings: { tone: "formal" }, connection: { name: "crm", type: "crm", level: "agent", value: { token: "t-1" } }, attempt: 1, callId: `tool-${n}:${call.seq}`, aborted: false });
    expect(provider.requests[0]?.system).toBe("Be careful.\n\nCall whoami when asked who you are.");
  });

  it("answers a call whose Connection is missing with an isError result", async () => {
    await scope.agents.connections.delete("guarded", "crm");
    provider.script([[reply.toolCall("whoami", {}, "c1")], "Ok"]);
    const events = await fresh("guarded").send(message("Who am I?"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: true, content: [{ type: "text", text: 'Connection "crm" is not available.' }] });
  });

  it("rejects input that fails the Tool's schema before running it", async () => {
    provider.script([[reply.toolCall("book", { room: "seven" }, "c1")], "Ok"]);
    const events = await fresh().send(message("Book"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: true });
    expect((events.find((e) => e.type === "tool.result") as { content: { text: string }[] }).content[0]!.text).toMatch(/^Invalid input for "book": room:/);
    expect(trace).not.toContain("book:start:seven");
  });

  it("answers an unknown Tool name with an isError result", async () => {
    provider.script([[reply.toolCall("teleport", {}, "c1")], "Ok"]);
    const events = await fresh().send(message("Go"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", name: "teleport", isError: true, content: [{ type: "text", text: 'Unknown tool "teleport".' }] });
  });
});

describe("Spill", () => {
  it("stores an oversized result whole, shows head + tail + marker, and read_output pages it back", async () => {
    provider.script([[reply.toolCall("big_output", { lines: 100 }, "c1")], [reply.toolCall("read_output", { ref: "7", offset: 50, limit: 3 }, "c2")], "Read it"]);
    const thread = fresh();
    const events = await thread.send(message("Dump"));
    const spilled = events.find((e) => e.type === "tool.result" && e.id === "c1");
    expect(spilled).toMatchObject({ isError: false, output: { id: "7", key: `test/threads/tool-${n}/tool-output/7`, mimeType: "text/plain; charset=utf-8", bytes: 791 } });
    const shown = (spilled as { content: { text: string }[] }).content[0]!.text;
    expect(shown.startsWith("line 1\nline 2\nline 3\nline 4\nline 5\n")).toBe(true);
    expect(shown.endsWith("\nline 96\nline 97\nline 98\nline 99\nline 100")).toBe(true);
    expect(shown).toContain('[... 717 characters (90 lines) omitted. The full output is stored as ref "7"; call read_output with that ref to read it. ...]');
    expect(events).toContainEvent({ type: "tool.result", id: "c2", name: "read_output", isError: false, content: [{ type: "text", text: "line 51\nline 52\nline 53" }] });
    expect(events).toContainEvent({ type: "turn.completed", stopReason: "end_turn" });
  });

  it("refuses to read an output that is not on this Thread", async () => {
    provider.script([[reply.toolCall("read_output", { ref: "999" }, "c1")], "Ok"]);
    const events = await fresh().send(message("Read"));
    expect(events).toContainEvent({ type: "tool.result", id: "c1", isError: true, content: [{ type: "text", text: 'No stored output "999" on this Thread.' }] });
  });
});
