import { afterEach, expect, it } from "vitest";
import { reply } from "../src/testing/index";
import { scope, provider, clock } from "./worker";

const opened: ReturnType<typeof scope.thread>[] = [];
afterEach(async () => {
  for (const thread of opened.splice(0)) await thread.cancel();
});

it("delegates to a fresh child Thread and resumes with its final message", async () => {
  await scope.agents.put({
    agentId: "delegator",
    name: "Delegator",
    instructions: [],
    model: { id: "shared/parent" },
    delegates: ["concierge"],
    capabilities: { delegation: {} },
  });
  provider.script(({ request }) =>
    request.model === "parent"
      ? request.messages.some((m) => m.role === "toolResult")
        ? "Parent done"
        : reply.toolCall("delegate", { agent: "concierge", task: "Child task" }, "child-call")
      : "Child done",
  );
  const thread = scope.thread({ agent: "delegator", user: "guest-1", threadId: "delegation-basic" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Private parent context" }] });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  const events = await thread.events();
  expect(events).toContainEvent({
    type: "tool.result",
    name: "delegate",
    isError: false,
    content: [{ type: "text", text: "Child done" }],
  });
  expect(events).toContainEvent({ type: "delegation.started" });
  expect(events).toContainEvent({ type: "delegation.completed" });
  const childRequest = provider.requests.find((r) => r.model !== "parent");
  expect(JSON.stringify(childRequest?.messages)).toContain("Child task");
  expect(JSON.stringify(childRequest?.messages)).not.toContain("Private parent context");
  expect(provider.requests[0]?.system).toContain("concierge");
});

it("bubbles child approvals, forwards answers by name, and keeps remember child-scoped", async () => {
  await scope.agents.put({
    agentId: "delegation-ask",
    name: "Parent",
    instructions: [],
    model: { id: "shared/parent-ask" },
    tools: ["book"],
    delegates: ["asking"],
    capabilities: { delegation: {} },
  });
  provider.script(({ request }) => {
    const results = request.messages.filter((m) => m.role === "toolResult");
    if (request.model === "parent-ask") {
      if (results.length === 0)
        return reply.toolCall("delegate", { agent: "asking", task: "Book a room" }, "ask-child");
      if (results.length === 1) return reply.toolCall("book", { room: 3 }, "parent-book");
      return "Parent done";
    }
    return results.length === 0 ? reply.toolCall("book", { room: 2 }, "child-book") : "Child booked";
  });
  const thread = scope.thread({ agent: "delegation-ask", user: "guest-1", threadId: "delegation-approval" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Book" }] });
  await expect.poll(async () => (await thread.status()).pendingApprovals?.length).toBe(1);
  const approval = (await thread.status()).pendingApprovals![0]!;
  expect(approval).toMatchObject({
    tool: "book",
    child: { threadId: expect.stringMatching(/^delegation-approval\//) },
  });
  const children = await scope.threads.list({ agent: "asking", parent: thread.key });
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({
    user: "guest-1",
    parent: { threadKey: thread.key, callId: expect.stringMatching(/^delegation-approval:\d+$/) },
  });
  expect(await scope.threads.list({ agent: "asking", parent: null })).not.toContainEqual(
    expect.objectContaining({ key: children[0]!.key }),
  );
  await thread.approve(approval.seq, { decision: "allow", remember: true, by: "alice" });
  await expect
    .poll(async () => (await thread.status()).pendingApprovals?.some((a) => a.tool === "book" && !a.child))
    .toBe(true);
  const parentAsk = (await thread.status()).pendingApprovals!.find((a) => !a.child)!;
  await thread.approve(parentAsk.seq, { decision: "deny" });
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  const child = scope.thread(children[0]!.key);
  expect(await child.events()).toContainEvent({
    type: "approval.resolved",
    tool: "book",
    decision: "allow",
    remember: true,
    by: "alice",
  });
  expect((await child.status()).parent).toEqual({
    threadKey: thread.key,
    callId: expect.stringMatching(/^delegation-approval:\d+$/),
  });
});

it("starts a batch concurrently and cascades cancellation down to both parked children", async () => {
  await scope.agents.put({
    agentId: "delegation-parallel",
    name: "Parent",
    instructions: [],
    model: { id: "shared/parallel" },
    delegates: ["asking"],
    capabilities: { delegation: { maxConcurrent: 2 } },
  });
  provider.script(({ request }) =>
    request.model === "parallel"
      ? [
          reply.toolCall("delegate", { agent: "asking", task: "First" }, "one"),
          reply.toolCall("delegate", { agent: "asking", task: "Second" }, "two"),
        ]
      : reply.toolCall("book", { room: 1 }, "book"),
  );
  const thread = scope.thread({ agent: "delegation-parallel", threadId: "delegation-parallel" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Two children" }] });
  await expect.poll(async () => (await thread.status()).pendingApprovals?.length).toBe(2);
  expect((await thread.status()).budget?.delegated).toEqual({ children: 2, active: 2 });
  const children = await scope.threads.list({ agent: "asking", parent: thread.key });
  expect(children).toHaveLength(2);
  await thread.cancel();
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  for (const summary of children) {
    const child = scope.thread(summary.key);
    await expect.poll(async () => (await child.status()).state).toBe("idle");
    expect(await child.events()).toContainEvent({ type: "turn.failed", reason: "cancelled" });
  }
});

it("rejects a cycle and enforces an ancestor's child cap in a descendant", async () => {
  await scope.agents.put({
    agentId: "delegation-middle",
    name: "Middle",
    instructions: [],
    model: { id: "shared/middle" },
    delegates: ["asking"],
    capabilities: { delegation: {} },
  });
  await scope.agents.put({ agentId: "delegation-root", name: "Root", instructions: [], model: { id: "shared/root" } });
  await scope.agents.put({
    agentId: "delegation-root",
    name: "Root",
    instructions: [],
    model: { id: "shared/root" },
    delegates: ["delegation-middle", "delegation-root"],
    capabilities: { delegation: { maxChildren: 1 } },
  });
  provider.script(({ request }) => {
    const result = request.messages.find((m) => m.role === "toolResult");
    if (result) return JSON.stringify(result);
    if (request.model === "root")
      return [
        reply.toolCall("delegate", { agent: "delegation-root", task: "Cycle" }, "cycle"),
        reply.toolCall("delegate", { agent: "delegation-middle", task: "Nested" }, "middle"),
      ];
    return reply.toolCall("delegate", { agent: "asking", task: "Too many" }, "leaf");
  });
  const thread = scope.thread({ agent: "delegation-root", threadId: "delegation-caps" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Nested" }] });
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  expect(await thread.events()).toContainEvent({
    type: "tool.result",
    id: "cycle",
    isError: true,
    content: [{ type: "text", text: "limit_exceeded: maxDepth" }],
  });
  const children = await scope.threads.list({ agent: "delegation-middle", parent: thread.key });
  expect(children).toHaveLength(1);
  expect(await scope.thread(children[0]!.key).events()).toContainEvent({
    type: "tool.result",
    name: "delegate",
    isError: true,
    content: [{ type: "text", text: "limit_exceeded: maxChildren" }],
  });
});

it("bounds parked descendants with the parent's wall deadline", async () => {
  await scope.agents.put({
    agentId: "delegation-timed",
    name: "Timed",
    instructions: [],
    model: { id: "shared/timed" },
    delegates: ["asking"],
    capabilities: { delegation: {}, longRunning: { maxWallMs: 1000 } },
  });
  provider.script(({ request }) =>
    request.model === "timed"
      ? reply.toolCall("delegate", { agent: "asking", task: "Book" }, "timed")
      : reply.toolCall("book", { room: 1 }),
  );
  const thread = scope.thread({ agent: "delegation-timed", threadId: "delegation-timed" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Book" }] });
  await expect.poll(async () => (await thread.status()).pendingApprovals?.length).toBe(1);
  await clock.advance("2s");
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  const children = await scope.threads.list({ agent: "asking", parent: thread.key });
  expect(await scope.thread(children[0]!.key).status()).toMatchObject({ state: "idle" });
});

it("bubbles a child continue and reports a refused budget as an error without ending the parent", async () => {
  await scope.agents.put({
    agentId: "delegation-budget-child",
    name: "Child",
    instructions: [],
    model: { id: "shared/budget-child" },
    tools: ["lookup"],
    policy: [{ match: { tool: "*" }, effect: "allow" }],
    capabilities: { longRunning: { maxSteps: 1 } },
  });
  await scope.agents.put({
    agentId: "delegation-budget-root",
    name: "Root",
    instructions: [],
    model: { id: "shared/budget-root" },
    delegates: ["delegation-budget-child"],
    capabilities: { delegation: {} },
  });
  provider.script(({ request }) =>
    request.model === "budget-root"
      ? request.messages.some((m) => m.role === "toolResult")
        ? "Parent handled error"
        : reply.toolCall("delegate", { agent: "delegation-budget-child", task: "Work" }, "budget")
      : reply.toolCall("lookup", { id: "guest" }),
  );
  const thread = scope.thread({ agent: "delegation-budget-root", threadId: "delegation-budget" });
  opened.push(thread);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Work" }] });
  await expect.poll(async () => (await thread.status()).pendingApprovals?.length).toBe(1);
  const approval = (await thread.status()).pendingApprovals![0]!;
  expect(approval).toMatchObject({
    kind: "continue",
    child: { threadId: expect.stringMatching(/^delegation-budget\//) },
  });
  await thread.approve(approval.seq, { decision: "deny" });
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  expect(await thread.events()).toContainEvent({ type: "tool.result", name: "delegate", isError: true });
  expect(await thread.events()).toContainEvent({
    type: "turn.completed",
    message: [{ type: "text", text: "Parent handled error" }],
  });
});
