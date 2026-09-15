import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/index";
import { lastMessage, reply } from "../src/testing/index";
import { provider, scope } from "./worker";

// Memory at Turn level: the Fragment, the `remember` and `recall` built-ins, sharing across Agents and
// Delegation children, the user-less degrade and the Scope's User index. Storage is shared across the
// file, so each test uses its own User.
let n = 0;
const fresh = (agent: string, user?: string) =>
  scope.thread({ agent, ...(user !== undefined && { user }), threadId: `m${++n}` });
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
/** The text of the Tool result with call id `id` in `events`. */
const resultText = (events: ThreadEvent[], id: string) => {
  const result = events.find((event) => event.type === "tool.result" && event.id === id);
  return result?.type === "tool.result"
    ? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : undefined;
};
const toolNames = (request: number) => provider.requests[request]?.tools?.map((tool) => tool.name) ?? [];
const opened: ReturnType<typeof scope.thread>[] = [];
afterEach(async () => {
  for (const thread of opened.splice(0)) await thread.cancel();
});

describe("remember and recall", () => {
  it("renders an empty Fragment after the Skills, writes in one Turn, reads its own writes, and shows them next Turn", async () => {
    provider.script([
      [
        reply.toolCall("remember", { profile: { tier: "gold" }, note: "Travels with a cat named Ada" }, "c0"),
        reply.toolCall("recall", { query: "cat" }, "c1"),
      ],
      "Noted",
      "Welcome back",
    ]);
    const thread = fresh("memo", "alice");
    const events = await thread.send(message("I'm gold tier and I travel with my cat Ada"));
    const first = provider.requests[0]?.system ?? "";
    expect(first.indexOf("# Skills")).toBeLessThan(first.indexOf("# Memory"));
    expect(first).toContain("Nothing is known about this user yet.");
    expect(toolNames(0)).toEqual(expect.arrayContaining(["remember", "recall"]));
    expect(provider.requests[0]?.tools?.find((tool) => tool.name === "remember")?.description).toContain(
      '"tier":{"type":"string","enum":["silver","gold"]}',
    );
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c0",
      isError: false,
      content: [{ type: "text", text: "Profile updated. Note saved." }],
    });
    expect(resultText(events, "c1")).toMatch(/^- \d{4}-\d{2}-\d{2}: Travels with a cat named Ada$/);
    expect(lastMessage(events)).toBe("Noted");
    // The Fragment is fixed for the Turn, so the Step after the write still sends the same prompt.
    expect(provider.requests[1]?.system).toBe(first);

    await fresh("memo", "alice").send(message("Hi again"));
    const system = provider.requests[2]?.system ?? "";
    expect(system).toContain('## Profile\n- tier: "gold"');
    expect(system).toMatch(/## Recent notes\n- \d{4}-\d{2}-\d{2}: Travels with a cat named Ada/);
    expect(await scope.users.memory.get("alice")).toEqual({
      profile: { tier: "gold" },
      notes: [{ id: 1, text: "Travels with a cat named Ada", agent: "memo", at: expect.any(Number) }],
    });
  });

  it("answers a miss, an empty write and a bad field with an error the model can act on", async () => {
    provider.script([
      [
        reply.toolCall("recall", { query: "zebra" }, "c0"),
        reply.toolCall("remember", {}, "c1"),
        reply.toolCall("remember", { profile: { tier: "bronze", colour: "red" } }, "c2"),
      ],
      "Ok",
    ]);
    const events = await fresh("memo", "bob").send(message("hi"));
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c0",
      isError: false,
      content: [{ type: "text", text: 'No notes match "zebra".' }],
    });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: true,
      content: [{ type: "text", text: "Give a `profile`, a `note`, or both." }],
    });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c2",
      isError: true,
      content: [
        {
          type: "text",
          text: '"tier" must be one of "silver", "gold". "colour" is not a profile field of this Agent.',
        },
      ],
    });
    expect(await scope.users.memory.get("bob")).toEqual({ profile: {}, notes: [] });
  });

  it("ranks recall by match and caps it at limit", async () => {
    provider.script([
      [
        reply.toolCall("remember", { note: "Likes window seats" }, "c0"),
        reply.toolCall("remember", { note: "Window seat, aisle never; window is a must" }, "c1"),
        reply.toolCall("remember", { note: "Vegetarian" }, "c2"),
        reply.toolCall("recall", { query: "window seat", limit: 1 }, "c3"),
      ],
      "Ok",
    ]);
    const events = await fresh("memo", "carol").send(message("hi"));
    expect(resultText(events, "c3")).toMatch(/^- \S+: Window seat, aisle never; window is a must$/);
  });
});

describe("sharing", () => {
  it("shares one Memory across the Scope's Agents: each validates only its own fields and preserves the rest", async () => {
    provider.script([
      [reply.toolCall("remember", { profile: { tier: "gold", seat: "window" }, note: "From memo" }, "c0")],
      "Memo done",
      [
        reply.toolCall("remember", { profile: { tier: "silver" } }, "c1"),
        reply.toolCall("remember", { profile: { seat: "aisle", visits: 2 } }, "c2"),
        reply.toolCall("recall", { query: "memo" }, "c3"),
      ],
      "Porter done",
    ]);
    await fresh("memo", "dave").send(message("hi"));
    const events = await fresh("porter", "dave").send(message("hi"));
    expect(provider.requests[2]?.system).toContain('- tier: "gold"\n- seat: "window"');
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: true,
      content: [{ type: "text", text: '"tier" is not a profile field of this Agent.' }],
    });
    expect(events).toContainEvent({ type: "tool.result", id: "c2", isError: false });
    expect(resultText(events, "c3")).toContain("From memo");
    expect((await scope.users.memory.get("dave")).profile).toEqual({ tier: "gold", seat: "aisle", visits: 2 });
  });

  it("lets a Delegation child write the parent's User Memory", async () => {
    provider.script(({ request }) =>
      request.messages.some((m) => m.role === "toolResult")
        ? "Done"
        : request.system?.includes("Delegate.")
          ? reply.toolCall("delegate", { agent: "memo", task: "Remember the seat" }, "child-call")
          : reply.toolCall("remember", { profile: { seat: "window" }, note: "Written by the child" }, "child-write"),
    );
    const thread = fresh("memo-delegator", "erin");
    opened.push(thread);
    await thread.send(message("Go"));
    await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
    expect(await scope.users.memory.get("erin")).toEqual({
      profile: { seat: "window" },
      notes: [{ id: 1, text: "Written by the child", agent: "memo", at: expect.any(Number) }],
    });
  });
});

describe("degrade", () => {
  it("offers only remember without Notes, refuses a note, and renders no notes section", async () => {
    provider.script([
      [
        reply.toolCall("remember", { profile: { seat: "window" } }, "c0"),
        reply.toolCall("remember", { note: "nope" }, "c1"),
      ],
      "Ok",
      "Again",
    ]);
    const events = await fresh("memo-quiet", "frank").send(message("hi"));
    expect(toolNames(0)).toContain("remember");
    expect(toolNames(0)).not.toContain("recall");
    expect(events).toContainEvent({ type: "tool.result", id: "c0", isError: false });
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c1",
      isError: true,
      content: [{ type: "text", text: "Notes are disabled for this agent; write to `profile` instead." }],
    });
    await fresh("memo-quiet", "frank").send(message("hi"));
    const system = provider.requests[2]?.system ?? "";
    expect(system).toContain('- seat: "window"');
    expect(system).not.toContain("## Recent notes");
    expect(system).toContain("Update the profile with `remember`.");
  });

  it("renders nothing and answers isError on a user-less Thread", async () => {
    provider.script([
      [reply.toolCall("remember", { note: "x" }, "c0"), reply.toolCall("recall", { query: "x" }, "c1")],
      "Ok",
    ]);
    const events = await fresh("memo").send(message("hi"));
    expect(provider.requests[0]?.system).not.toContain("# Memory");
    const unavailable = {
      isError: true,
      content: [{ type: "text" as const, text: "This thread has no user, so there is no memory to use." }],
    };
    expect(events).toContainEvent({ type: "tool.result", id: "c0", ...unavailable });
    expect(events).toContainEvent({ type: "tool.result", id: "c1", ...unavailable });
  });

  it("applies the Policy: a denied remember is hidden and refused", async () => {
    provider.script([[reply.toolCall("remember", { note: "x" }, "c0")], "Ok"]);
    const events = await fresh("memo-denied", "gina").send(message("hi"));
    expect(toolNames(0)).not.toContain("remember");
    expect(toolNames(0)).toContain("recall");
    expect(events).toContainEvent({
      type: "tool.result",
      id: "c0",
      isError: true,
      content: [{ type: "text", text: 'Tool "remember" is denied by the Permission Policy.' }],
    });
  });
});

describe("scope.users.memory", () => {
  it("indexes every User a Memory Turn ran for, and delete empties the Memory and the index", async () => {
    provider.script([[reply.toolCall("remember", { note: "Keep" }, "c0")], "Ok"]);
    await fresh("memo", "hank").send(message("hi"));
    expect(await scope.users.memory.list()).toContain("hank");
    await scope.users.memory.delete("hank");
    expect(await scope.users.memory.get("hank")).toEqual({ profile: {}, notes: [] });
    expect(await scope.users.memory.list()).not.toContain("hank");
    await expect(scope.users.memory.get("../x")).rejects.toMatchObject({ code: "user.id.invalid" });
  });
});
