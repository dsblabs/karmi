import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SCENARIOS, viewScenario } from "../src/scenarios";
import { SCRIPT_LIMITS, SCRIPT_PROMPTS, SCRIPTS } from "../src/scripts";
import { api as request, events } from "./client";
import { scriptReplies } from "./script";
import { provider } from "./worker";
import { setup, TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${SCRIPTS}`;

const runSchema = z.object({
  callId: z.string(),
  code: z.string(),
  state: z.enum(["running", "done", "failed", "stopped"]),
  value: z.unknown().optional(),
  error: z.string().optional(),
  explanation: z.string().optional(),
  logs: z.array(z.string()),
  calls: z.array(
    z.object({
      callId: z.string(),
      parentCallId: z.string(),
      name: z.string(),
      input: z.unknown(),
      isError: z.boolean().optional(),
      interrupted: z.boolean().optional(),
    }),
  ),
});

const stateSchema = z.looseObject({
  threadKey: z.string(),
  orders: z.array(z.object({ id: z.string(), status: z.string(), total: z.number() })),
  grant: z.looseObject({ tier: z.literal("isolate"), limits: z.looseObject({}) }),
  runs: z.array(runSchema),
});

const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());
const prompt = (label: string) => {
  const found = SCRIPT_PROMPTS.find((item) => item.label === label);
  if (!found) throw new Error(`No prompt ${label}.`);
  return found.text;
};
const statusOf = async (id: string) => (await state()).orders.find((order) => order.id === id)?.status;

async function until(key: string, done: (log: ThreadEvent[]) => boolean, timeout = 10_000): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect.poll(async () => done((log = await events(key))), { timeout }).toBe(true);
  return log;
}
const ended = (log: ThreadEvent[]) =>
  log.some((event) => event.type === "turn.completed" || event.type === "turn.failed");

/** Sends one guided prompt. Returns the Thread key and the last Script run after the Turn ends. */
async function run(label: string, timeout?: number) {
  const { threadKey } = await state();
  const sent = await api("POST", `/threads/${threadKey}/turns`, {
    kind: "message",
    parts: [{ type: "text", text: prompt(label) }],
  });
  expect(sent.status).toBe(202);
  const log = await until(threadKey, ended, timeout);
  const last = (await state()).runs.at(-1);
  if (!last) throw new Error("No Script ran.");
  return { threadKey, log, last };
}

beforeEach(async () => {
  provider.script(scriptReplies);
  await api("POST", `${PATH}/reset`);
});

describe("the isolate Scripts scenario", () => {
  it("is unavailable without the KARMI_LOADER binding and tells how to get it", () => {
    const scenario = SCENARIOS.find((item) => item.id === SCRIPTS);
    if (!scenario) throw new Error("The Scripts scenario is missing.");
    expect(viewScenario(scenario, setup, { hasLoader: true }).status).toBe("ready");
    expect(viewScenario(scenario, setup, { hasLoader: false })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("Workers Paid plan"),
    });
  });

  it("shows the sample orders, the grant with its limits and no Script run", async () => {
    const now = await state();
    expect(now.orders.map((order) => order.status)).toEqual(["open", "open", "open", "shipped"]);
    expect(now.grant).toMatchObject({ tier: "isolate", tools: "allowed", limits: SCRIPT_LIMITS });
    expect(now.runs).toEqual([]);
  });

  it("runs the Script through the real Loader and links each nested Tool call to its Script", async () => {
    const { log, last } = await run("Tool calls");
    const script = log.find((event) => event.type === "tool.call" && event.name === "run_script");
    expect(last.callId).toMatch(new RegExp(`^${SCRIPTS}-\\d+:${String(script?.seq)}$`));
    expect(last).toMatchObject({ state: "done", value: { count: 3, total: 105 }, logs: ["Read 3 open orders"] });
    expect(last.calls.map((call) => call.name)).toEqual(["find_orders", "read_order", "read_order", "read_order"]);
    expect(last.calls.every((call) => call.parentCallId === last.callId && call.isError === false)).toBe(true);
    expect(log).toContainEvent({ type: "tool.call", name: "read_order", parentCallId: last.callId });
    // The model gets one result: the result of the Script, not the nested ones.
    expect(provider.requests.at(-1)?.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
  });

  it("keeps a Tool that needs an Approval out of the Script and asks for no Approval", async () => {
    const { log, last } = await run("Tool that needs an Approval");
    // The Script also gets the built-in Tools of the Framework that the Agent has, for example `tool_search`.
    expect(last.logs[0]).toMatch(/^Tools of this Script: find_orders, read_order, pack_box\b/);
    expect(last.logs[0]).not.toContain("cancel_order");
    expect(last).toMatchObject({ state: "failed", error: expect.stringContaining("cancel_order") });
    expect(last.explanation).toContain("Approval");
    expect(log.some((event) => event.type === "approval.requested")).toBe(false);
    expect(await statusOf("B-201")).toBe("open");
  });

  it("gives a Script no network access", async () => {
    const { last } = await run("Network");
    expect(last.state).toBe("failed");
    expect(last.error).toContain("not permitted to access the internet");
    expect(last.explanation).toContain("no network access");
  });

  it("ends a Script at maxToolCalls", async () => {
    const { last } = await run("Tool-call limit");
    expect(last).toMatchObject({ state: "failed", error: "limit_exceeded: maxToolCalls" });
    expect(last.calls).toHaveLength(SCRIPT_LIMITS.maxToolCalls);
    expect(last.logs).toHaveLength(SCRIPT_LIMITS.maxToolCalls);
    expect(last.explanation).toContain("maxToolCalls");
  });

  it("ends a Script at wallMs", { timeout: 30_000 }, async () => {
    const { last } = await run("Time limit", 25_000);
    expect(last).toMatchObject({ state: "failed", error: "limit_exceeded: wallMs", logs: ["Waiting for 60 seconds"] });
    expect(last.explanation).toContain("wallMs");
  });

  it("runs the CPU limit Script to the end, because local workerd does not enforce cpuMs", async () => {
    const { last } = await run("CPU limit");
    expect(last).toMatchObject({ state: "done", value: expect.any(Number) });
  });

  it("stops the Script when the Turn is cancelled and keeps the box that a Tool packed", async () => {
    const { threadKey } = await state();
    await api("POST", `/threads/${threadKey}/turns`, {
      kind: "message",
      parts: [{ type: "text", text: prompt("Cancel") }],
    });
    await until(threadKey, (log) =>
      log.some((event) => event.type === "tool.result" && event.name === "pack_box" && event.parentCallId),
    );
    expect((await api("POST", `/threads/${threadKey}/cancel`)).status).toBeLessThan(300);
    const log = await until(threadKey, ended);
    expect(log).toContainEvent({ type: "turn.failed", reason: "cancelled" });
    // The Script sleeps for two seconds after each box. Wait longer, then check that it packed nothing more.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const now = await state();
    expect(now.orders.filter((order) => order.status === "packed").map((order) => order.id)).toEqual(["B-201"]);
    expect(now.runs.at(-1)).toMatchObject({ state: "stopped", explanation: expect.stringContaining("stays") });
    // The cancel closes each call. No nested call stays without a result.
    expect(now.runs.at(-1)?.calls.every((call) => call.isError !== undefined)).toBe(true);
  });

  it("leaves no Script work after a reset", async () => {
    const { threadKey } = await state();
    await api("POST", `/threads/${threadKey}/turns`, {
      kind: "message",
      parts: [{ type: "text", text: prompt("Cancel") }],
    });
    await until(threadKey, (log) => log.some((event) => event.type === "tool.result" && event.name === "pack_box"));
    const reset = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(reset.threadKey).not.toBe(threadKey);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const now = await state();
    expect(now.orders.map((order) => order.status)).toEqual(["open", "open", "open", "shipped"]);
    expect(now.runs).toEqual([]);
  });
});
