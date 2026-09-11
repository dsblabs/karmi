import { describe, expect, it } from "vitest";
import { lastMessage, reply } from "../src/testing/index.js";
import { provider, scope, shelves } from "./worker.js";

// Progressive disclosure at Turn level: what the model is offered, what `tool_search` and `use_skill`
// load, and how long a load lasts. Storage is shared across the file, so each test uses its own Thread.
let n = 0;
const fresh = (agent = "librarian") => scope.thread({ agent, user: "guest-1", threadId: `d${++n}` });
const message = (text: string, skill?: string) => ({
  kind: "message" as const,
  parts: [{ type: "text" as const, text }],
  ...(skill !== undefined && { skill }),
});
const shelfNames = shelves.map((tool) => tool.name);
const names = (request: number, filter: (deferred: boolean) => boolean) =>
  provider.requests[request]?.tools?.filter((tool) => filter(tool.deferred === true)).map((tool) => tool.name);
/** About 250 tokens: enough that the latest Turn alone covers `keepRecentTokens`. */
const big = (label: string) => `${label} ${"x".repeat(1000)}`;

describe("deferral", () => {
  it("defers the deferrable set once it crosses the threshold; pins, built-ins and the index stay visible", async () => {
    provider.script(["Hi"]);
    await fresh().send(message("hi"));
    expect(names(0, (deferred) => deferred)).toEqual(shelfNames);
    expect(names(0, (deferred) => !deferred)).toEqual(["weather", "read_output", "tool_search", "use_skill"]);
    const system = provider.requests[0]?.system ?? "";
    expect(system).toContain("# Deferred tools");
    expect(system).toContain("## Tools\n- shelf_01\n- shelf_02");
    expect(system).not.toContain("- weather");
    expect(system).toContain("# Skills");
    expect(system).toContain("- research: Deep research into the archive");
    expect(system).toContain("- deploy (invoked by the user): Deploy checklist");
  });

  it("defers nothing under the threshold, and still offers tool_search", async () => {
    provider.script(["Hi"]);
    await fresh("librarian-wide").send(message("hi"));
    expect(names(0, (deferred) => deferred)).toEqual([]);
    expect(names(0, (deferred) => !deferred)).toEqual([
      "weather",
      ...shelfNames,
      "read_output",
      "tool_search",
      "use_skill",
    ]);
    expect(provider.requests[0]?.system).not.toContain("# Deferred tools");
  });
});

describe("tool_search", () => {
  it("refuses an unloaded call, loads by select: with a load point, and keeps the load across Turns", async () => {
    provider.script([
      [
        reply.toolCall("shelf_04", { item: "early" }, "c0"),
        reply.toolCall("tool_search", { query: "select:shelf_03, nope" }, "c1"),
      ],
      [reply.toolCall("shelf_03", { item: "a" }, "c2")],
      "Done",
      [reply.toolCall("shelf_03", { item: "b" }, "c3")],
      "Again",
    ]);
    const thread = fresh();
    const events = await thread.send(message("Fetch"));
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c0",
      isError: true,
      content: [
        {
          type: "text",
          text: 'Tool "shelf_04" is not loaded. Load it with tool_search (select:shelf_04) before calling it.',
        },
      ],
    });
    expect(events).toHaveSequence(["tool.call", "tools.loaded", "tool.result", "step.completed"]);
    expect(events).toContainEvent({ type: "tools.loaded", names: ["shelf_03"] });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: false,
      content: [
        { type: "tool_reference", name: "shelf_03" },
        { type: "text", text: "Not in the deferred index: nope." },
      ],
    });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: false,
      content: [{ type: "text", text: "Shelf 3 holds a" }],
    });
    expect(lastMessage(events)).toBe("Done");
    // The loaded Tool leaves the index but keeps its deferred definition; the load point rides in the transcript.
    expect(provider.requests[1]?.system).not.toContain("- shelf_03\n");
    expect(provider.requests[1]?.system).toContain("- shelf_04\n");
    expect(provider.requests[1]?.tools?.find((tool) => tool.name === "shelf_03")).toMatchObject({ deferred: true });
    expect(provider.requests[1]?.messages).toContainEqual({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "tool_search",
      content: [
        { type: "tool_reference", name: "shelf_03" },
        { type: "text", text: "Not in the deferred index: nope." },
      ],
      isError: false,
    });

    const next = await thread.send(message("Fetch again"));
    expect(next).toContainEvent({
      type: "tool.result",
      id: "c3",
      isError: false,
      content: [{ type: "text", text: "Shelf 3 holds b" }],
    });
    expect(lastMessage(next)).toBe("Again");
  });

  it("matches keywords over the index and loads the matches", async () => {
    provider.script([[reply.toolCall("tool_search", { query: "maps" }, "c1")], "Ok"]);
    const events = await fresh().send(message("Maps?"));
    expect(events).toContainEvent({ type: "tools.loaded", names: ["shelf_01", "shelf_02"] });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      content: [
        { type: "tool_reference", name: "shelf_01" },
        { type: "tool_reference", name: "shelf_02" },
      ],
    });
  });

  it("answers a miss with text and no load point", async () => {
    provider.script([[reply.toolCall("tool_search", { query: "zebra" }, "c1")], "Ok"]);
    const events = await fresh().send(message("Zebra?"));
    expect(events.map((e) => e.type)).not.toContain("tools.loaded");
    const result = events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ id: "c1", isError: false });
    expect(
      result?.type === "tool.result" && result.content[0]?.type === "text" ? result.content[0].text : "",
    ).toContain('No deferred tool matches "zebra"');
  });

  it("unloads what a Compaction cuts away: the load point is gone, so the Tool is not loaded", async () => {
    provider.script([
      [reply.toolCall("tool_search", { query: "select:shelf_05" }, "c1")],
      [reply.text("loaded"), reply.usage({ input: 100 })],
      [reply.text("two"), reply.usage({ input: 3900 })],
      "SUMMARY",
      [reply.toolCall("shelf_05", { item: "z" }, "c2")],
      "three",
    ]);
    const thread = fresh();
    await thread.send(message("Load five"));
    await thread.send(message(big("two")));
    const events = await thread.send(message(big("three")));
    expect(events).toHaveSequence(["thread.compacted", "step.completed", "tool.call", "tool.result"]);
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: true,
      content: [
        {
          type: "text",
          text: 'Tool "shelf_05" is not loaded. Load it with tool_search (select:shelf_05) before calling it.',
        },
      ],
    });
    // Back in the index for the Step after the Compaction.
    expect(provider.requests[4]?.system).toContain("- shelf_05\n");
    expect(lastMessage(events)).toBe("three");
  });
});

describe("Skills", () => {
  it("activates through use_skill: the body is the result, its Tools are offered from the next Step on", async () => {
    provider.script([
      [reply.toolCall("search", { q: "early" }, "c0")],
      [reply.toolCall("use_skill", { name: "research" }, "c1")],
      [reply.toolCall("search", { q: "maps" }, "c2")],
      "Done",
    ]);
    const events = await fresh().send(message("Research maps"));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain("search");
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c0",
      isError: true,
      content: [
        {
          type: "text",
          text: 'Tool "search" belongs to the skill "research", which is not active. Activate it with use_skill first.',
        },
      ],
    });
    expect(events).toContainEvent({ type: "tools.loaded", names: ["search"], skill: { name: "research" } });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: false,
      content: [
        {
          type: "text",
          text: 'Skill "research" is active.\n\nSearch first, then summarise for guest-1.\n\nTools now available: search.',
        },
      ],
    });
    expect(provider.requests[2]?.tools?.map((tool) => tool.name)).toContain("search");
    expect(events).toContainEvent({ type: "tool.result", id: "c2", content: [{ type: "text", text: "Found maps" }] });
    expect(lastMessage(events)).toBe("Done");
  });

  it("tells the model when a Skill is already active or unknown", async () => {
    provider.script([
      [reply.toolCall("use_skill", { name: "research" }, "c1")],
      [reply.toolCall("use_skill", { name: "research" }, "c2"), reply.toolCall("use_skill", { name: "deploy" }, "c3")],
      "Done",
    ]);
    const events = await fresh().send(message("Research"));
    expect(events.filter((e) => e.type === "tools.loaded")).toHaveLength(1);
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: false,
      content: [{ type: "text", text: 'Skill "research" is already active.' }],
    });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c3",
      isError: true,
      content: [{ type: "text", text: 'No skill "deploy" is available.' }],
    });
  });

  it("activates a User-invokable Skill named on the Turn input before the first model Step", async () => {
    provider.script(["Deploying"]);
    const events = await fresh().send(message("Ship it", "deploy"));
    const body = 'Skill "deploy" is active.\n\nDeploy checklist.';
    expect(events).toHaveSequence(["turn.started", "tools.loaded", "step.started"]);
    expect(events).toContainEvent({ type: "tools.loaded", names: [], skill: { name: "deploy", body } });
    expect(provider.requests[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Ship it" }] },
      { role: "user", content: [{ type: "text", text: body }] },
    ]);
  });

  it("fails the Turn when the User names a Skill only the model may invoke", async () => {
    provider.script(["Never"]);
    const events = await fresh().send(message("Research this", "research"));
    expect(events).toContainEvent({
      type: "turn.failed",
      reason: "skill.unavailable",
      message: 'Skill "research" cannot be invoked by the User of Agent "librarian".',
    });
    expect(provider.requests).toHaveLength(0);
  });
});
