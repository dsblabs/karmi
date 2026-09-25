import { expect, it } from "vitest";
import { reply } from "../src/testing/index";
import { gate, karmi, provider, scope, trace } from "./worker";

it("runs a JS module through the real Loader and gates deferred child calls without adding them to context", async () => {
  await scope.agents.put({
    agentId: "scripter",
    name: "Scripter",
    instructions: [],
    model: { id: "fake/test" },
    tools: ["weather", "book"],
    context: { tools: { defer: "always" } },
    policy: [{ match: { tool: "*" }, effect: "allow" }],
    hooks: { "before-tool": ["rewrite-city"], "after-tool": ["observe"] },
    capabilities: { scripts: { tier: "isolate", tools: "allowed" } },
  });
  trace.length = 0;
  provider.script([
    [
      reply.toolCall(
        "run_script",
        {
          code: 'export default async () => { console.log("hello"); return await tools.weather({city: "London"}); }',
        },
        "script",
      ),
    ],
    "done",
  ]);
  const events = await scope.thread({ agent: "scripter", threadId: "script-basic" }).send({
    kind: "message",
    parts: [{ type: "text", text: "Run it" }],
  });
  const parent = events.find((e) => e.type === "tool.call" && e.name === "run_script");
  expect(parent, JSON.stringify(events)).toBeDefined();
  expect(events).toContainEvent({
    type: "tool.call",
    name: "weather",
    parentCallId: `script-basic:${parent?.seq}`,
    input: { city: "Paris" },
  });
  expect(events).toContainEvent({ type: "tool.result", name: "run_script", isError: false });
  expect(trace).toContain("after-tool:weather:ok");
  expect(provider.requests[1]?.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
  expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Sunny in Paris");
  expect(JSON.stringify(provider.requests[1]?.messages)).toContain("hello");
  expect(provider.requests[0]?.system).toContain('"weather"');
});

let serial = 0;
async function run(code: string, extra: Partial<import("../src/index").AgentSpec> = {}) {
  const agentId = `script-${++serial}`;
  await scope.agents.put({
    agentId,
    name: "Scripts",
    instructions: [],
    model: { id: "fake/test" },
    tools: ["weather", "book", "failing", { name: "whoami", settings: { tone: "friendly" } }],
    connections: { crm: { type: "crm", level: "user" } },
    policy: [{ match: { tool: "*" }, effect: "allow" }],
    capabilities: { scripts: { tier: "isolate", tools: "allowed" } },
    ...extra,
  });
  provider.script([[reply.toolCall("run_script", { code }, "script")], "done"]);
  const events = await scope
    .thread({ agent: agentId, threadId: agentId })
    .send({ kind: "message", parts: [{ type: "text", text: "Run" }] });
  const result = events.find((e) => e.type === "tool.result" && e.name === "run_script");
  expect(result, JSON.stringify(events)).toBeDefined();
  if (result?.type !== "tool.result") throw new Error("Missing script result");
  const text = result.content.find((b) => b.type === "text");
  if (text?.type !== "text") throw new Error("Missing script output");
  return { events, result, output: text.text.startsWith("{") ? JSON.parse(text.text) : text.text };
}

it("hides asked, denied, unselected and user-less Tools and excludes recursive or parking built-ins", async () => {
  const { output } = await run("export default () => Object.keys(tools)", {
    policy: [
      { match: { tool: "book" }, effect: "ask" },
      { match: { tool: "failing" }, effect: "deny" },
      { match: { tool: "*" }, effect: "allow" },
    ],
  });
  expect(output.value).toEqual(["weather", "read_output", "tool_search"]);
  expect(provider.requests[0]?.system).toContain("Unavailable on this user-less Thread: whoami");
  const selected = await run("export default () => Object.keys(tools)", {
    capabilities: { scripts: { tier: "isolate", tools: ["book"] } },
  });
  expect(selected.output.value).toEqual(["book"]);
});

it("enforces maxToolCalls even when the script catches the breach", async () => {
  const { events, output, result } = await run(
    'export default async () => { await tools.weather({city:"A"}); try { await tools.weather({city:"B"}); } catch {} return "ignored"; }',
    {
      capabilities: { scripts: { tier: "isolate", limits: { maxToolCalls: 1 } } },
    },
  );
  expect(result.isError).toBe(true);
  expect(output.error.message).toBe("limit_exceeded: maxToolCalls");
  expect(events.filter((e) => e.type === "tool.call" && e.name === "weather")).toHaveLength(1);
});

it("captures exceptions and console output with a stack", async () => {
  const { output, result } = await run(
    'export default () => { console.warn("before failure"); throw new Error("script boom"); }',
  );
  expect(result.isError).toBe(true);
  expect(output.error.message).toBe("script boom");
  expect(output.error.stack).toContain("script.js");
  expect(output.logs).toEqual(["[warn] before failure"]);
  expect(output.artifacts).toEqual([]);
});

it("rejects outbound fetch and unavailable imports", async () => {
  const network = await run('export default async () => await fetch("https://example.com")');
  expect(network.result.isError).toBe(true);
  const imports = await run('import fs from "node:fs"; export default () => fs');
  expect(imports.result.isError).toBe(true);
});

it("validates nested inputs and applies denial Hooks", async () => {
  const invalid = await run("export default async () => await tools.weather({city:12})");
  expect(invalid.output.error.message).toContain("Invalid input");
  const denied = await run("export default async () => await tools.book({room:1})", {
    hooks: { "before-tool": ["deny-booking"] },
  });
  expect(denied.output.error.message).toContain("No bookings today");
});

it("bounds a waiting script by wallMs and records script usage", async () => {
  const { output, result, events } = await run(
    "export default async () => { console.log('checkpoint'); await new Promise(resolve => setTimeout(resolve, 10000)); }",
    {
      capabilities: { scripts: { tier: "isolate", limits: { wallMs: 30 } } },
    },
  );
  expect(result.isError).toBe(true);
  expect(output.error.message).toBe("limit_exceeded: wallMs");
  expect(output.logs).toEqual(["checkpoint"]);
  expect(events).toContainEvent({ type: "usage.recorded", kind: "script", tier: "isolate", scope: "test" });
});

it("returns structured Tool values for composition", async () => {
  const { output } = await run("export default async () => (await tools.book({room:7})).room + 1");
  expect(output.value).toBe(8);
  expect(output.toolCalls).toEqual([expect.objectContaining({ name: "book", isError: false })]);
});

it("makes run_script absent without a grant", async () => {
  const { result } = await run("export default 1", { capabilities: {} });
  expect(result.isError).toBe(true);
  expect(provider.requests[0]?.tools?.some((t) => t.name === "run_script")).toBe(false);
});

it("reads prior results by stable callId on the same Thread", async () => {
  const { events } = await run("export default async () => await tools.book({room:23})");
  const call = events.find((e) => e.type === "tool.call" && e.name === "book");
  expect(call).toBeDefined();
  const threadId = `script-${serial}`;
  provider.script([
    [
      reply.toolCall("run_script", {
        code: `export default async () => (await __result(${JSON.stringify(`${threadId}:${call?.seq}`)})).room`,
      }),
    ],
    "done",
  ]);
  const continued = await scope
    .thread({ agent: threadId, threadId })
    .send({ kind: "message", parts: [{ type: "text", text: "Read it" }] });
  expect(JSON.stringify(continued.find((e) => e.type === "tool.result" && e.name === "run_script"))).toContain(
    '\\"value\\":23',
  );
  provider.script([
    [reply.toolCall("run_script", { code: 'export default async () => await __result("other-thread:1")' })],
    "done",
  ]);
  const rejected = await scope
    .thread({ agent: threadId, threadId })
    .send({ kind: "message", parts: [{ type: "text", text: "Read another" }] });
  expect(rejected).toContainEvent({ type: "tool.result", name: "run_script", isError: true });
});

it("composes complete spilled text and structured results and reads them on later Turns", async () => {
  for (const [tool, code, expected] of [
    ["big_output", 'return (await tools.big_output({lines:10000})).split("\\n").length', 10000],
    ["large_structured", "return (await tools.large_structured({})).rows.length", 100000],
  ] as const) {
    const { events, output } = await run(`export default async () => { ${code}; }`, { tools: [tool] });
    expect(output.value).toBe(expected);
    const call = events.find((e) => e.type === "tool.call" && e.name === tool);
    const threadId = `script-${serial}`;
    const read = `await __result(${JSON.stringify(`${threadId}:${call?.seq}`)})`;
    provider.script([
      [
        reply.toolCall("run_script", {
          code: `export default async () => { const value = ${read}; return ${tool === "big_output" ? 'value.split("\\n").length' : "value.rows.length"}; }`,
        }),
      ],
      "done",
    ]);
    const continued = await scope
      .thread({ agent: threadId, threadId })
      .send({ kind: "message", parts: [{ type: "text", text: "Read" }] });
    expect(JSON.stringify(continued.find((e) => e.type === "tool.result" && e.name === "run_script"))).toContain(
      `\\"value\\":${expected}`,
    );
    if (tool === "large_structured") {
      const result = events.find((e) => e.type === "tool.result" && e.name === tool);
      expect(result).toHaveProperty("structuredOutput");
      expect(result).not.toHaveProperty("structuredContent");
    }
  }
});

it("allows supported capability built-ins through the script gate", async () => {
  const { result } = await run("export default async () => await tools.list_schedules({})", {
    capabilities: { scripts: { tier: "isolate" }, scheduling: {} },
  });
  expect(result.isError).toBe(false);
});

it("preserves small binary structured values across Turns", async () => {
  const { events, output } = await run("export default async () => Array.from(await tools.binary_result({}))", {
    tools: ["binary_result"],
  });
  expect(output.value).toEqual([1, 2, 255]);
  const call = events.find((e) => e.type === "tool.call" && e.name === "binary_result");
  const threadId = `script-${serial}`;
  provider.script([
    [
      reply.toolCall("run_script", {
        code: `export default async () => Array.from(await __result(${JSON.stringify(`${threadId}:${call?.seq}`)}))`,
      }),
    ],
    "done",
  ]);
  const continued = await scope
    .thread({ agent: threadId, threadId })
    .send({ kind: "message", parts: [{ type: "text", text: "Read" }] });
  expect(JSON.stringify(continued.find((e) => e.type === "tool.result" && e.name === "run_script"))).toContain(
    '\\"value\\":[1,2,255]',
  );
});

it("inherits the Scope script ceiling when the grant omits limits and rejects an over-ask", async () => {
  const current = await scope.config.get();
  await scope.config.set({ ceilings: { scripts: { limits: { maxToolCalls: 1 } } } }, { ifRevision: current.revision });
  const { output } = await run(
    'export default async () => { await tools.weather({city:"A"}); await tools.weather({city:"B"}); }',
  );
  expect(output.error.message).toBe("limit_exceeded: maxToolCalls");
  const validation = await scope.agents.validate({
    agentId: "over-ask",
    name: "Over",
    instructions: [],
    model: { id: "fake/test" },
    capabilities: { scripts: { tier: "isolate", limits: { maxToolCalls: 2 } } },
  });
  expect(validation.ok).toBe(false);
  if (!validation.ok)
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "capability.over-ceiling", path: "/capabilities/scripts/limits/maxToolCalls" }),
    );
});

it("gives an interrupted result to a nested call that a cancel stops, and shows it to the model", async () => {
  await scope.agents.put({
    agentId: "script-cancel",
    name: "Scripts",
    instructions: [],
    model: { id: "fake/test" },
    tools: ["wait_gate"],
    policy: [{ match: { tool: "*" }, effect: "allow" }],
    capabilities: { scripts: { tier: "isolate", tools: "allowed" } },
  });
  gate.open = false;
  const entered = gate.entered;
  provider.script([
    [reply.toolCall("run_script", { code: "export default async () => await tools.wait_gate({})" }, "script")],
    "Checked",
  ]);
  const target = { agent: "script-cancel", threadId: "script-cancel" };
  const thread = scope.thread(target);
  await karmi
    .scope("test")
    .thread(target)
    .send({ kind: "message", parts: [{ type: "text", text: "Run" }] });
  await expect.poll(() => gate.entered).toBe(entered + 1);
  await thread.cancel();
  gate.open = true;
  await expect.poll(async () => (await thread.status()).state).toBe("idle");
  const events = await thread.events();
  const calls = events.filter((e) => e.type === "tool.call");
  const results = events.filter((e) => e.type === "tool.result");
  expect(results.map((e) => [e.name, e.parentCallId !== undefined, e.interrupted])).toEqual([
    ["wait_gate", true, { attempt: 1 }],
    ["run_script", false, { attempt: 1 }],
  ]);
  expect(calls).toHaveLength(2);
  expect(events.slice(-2).map((e) => e.type)).toEqual(["step.completed", "turn.failed"]);
  await thread.send({ kind: "message", parts: [{ type: "text", text: "Did it run?" }] });
  const [answer] = provider.requests.at(-1)?.messages.filter((m) => m.role === "toolResult") ?? [];
  expect(JSON.stringify(answer?.content)).toContain("may or may not have taken effect");
});
