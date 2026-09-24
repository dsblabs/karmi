import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PROVIDERS } from "../src/provider-desk";
import { api as request, events } from "./client";
import { providerDeskReplies } from "./script";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${PROVIDERS}`;

const settingsSchema = z.object({ profile: z.string(), webSearch: z.boolean(), policy: z.string() });

const stateSchema = z.object({
  threadKey: z.string(),
  profiles: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      model: z.string(),
      config: z.looseObject({ adapter: z.string() }),
      providerTools: z.array(z.string()),
    }),
  ),
  agent: z.object({ version: z.number(), spec: z.looseObject({}), settings: settingsSchema }),
  steps: z.array(
    z.object({
      turn: z.number(),
      profile: z.string(),
      provider: z.string(),
      model: z.string(),
      agentVersion: z.number(),
    }),
  ),
  calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      runsAt: z.enum(["harness", "provider"]),
      result: z.optional(z.string()),
    }),
  ),
  usage: z.array(
    z.looseObject({
      profile: z.string(),
      cost: z.optional(z.unknown()),
      gateway: z.optional(z.object({ provider: z.string(), id: z.string() })),
    }),
  ),
  turn: z.object({ state: z.string() }),
});

type State = z.infer<typeof stateSchema>;

const decode = async (response: Response): Promise<State> => {
  expect(response.status).toBe(200);
  return stateSchema.parse(await response.json());
};

const state = async () => decode(await api("GET", PATH));
const save = (settings: { profile: string; webSearch?: boolean; policy?: string }) =>
  api("POST", `${PATH}/agent`, { webSearch: false, policy: "none", ...settings });

const ends = (entries: ThreadEvent[]) =>
  entries.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length;

/** Sends one message through the public Thread route and returns the log after its Turn ends. */
async function run(text: string): Promise<ThreadEvent[]> {
  const { threadKey } = await state();
  const before = ends(await events(threadKey));
  const sent = await api("POST", `/threads/${threadKey}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
  let entries: ThreadEvent[] = [];
  await expect.poll(async () => ends((entries = await events(threadKey))), { timeout: 10_000 }).toBe(before + 1);
  return entries;
}

const SEARCH = "Search the web for the current version of the Cloudflare Wrangler CLI and name your source.";

beforeEach(async () => {
  provider.script(providerDeskReplies);
  await api("POST", `${PATH}/reset`);
});

describe("the Provider profiles", () => {
  it("lists each profile of setup with the Provider Tools that the Framework accepts on it", async () => {
    const { profiles, agent } = await state();
    expect(profiles.map(({ name, model, providerTools }) => ({ name, model, providerTools }))).toEqual([
      { name: "default", model: "fake/model", providerTools: [] },
      { name: "second", model: "anthropic/claude-test", providerTools: ["web_search"] },
      { name: "gateway", model: "openai/gpt-test", providerTools: ["web_search"] },
    ]);
    expect(agent.settings).toEqual({ profile: "default", webSearch: false, policy: "none" });
  });

  it("switches the profile of the same Thread, and the next Turn runs on the new Provider", async () => {
    const before = await state();
    await run("Which model?");
    const switched = await decode(await save({ profile: "second" }));
    expect(switched.agent.version).toBe(before.agent.version + 1);
    expect(switched.threadKey).toBe(before.threadKey);
    const entries = await run("Which model?");
    expect(entries).toContainEvent({ type: "turn.completed" });

    const { steps } = await state();
    expect(steps.map(({ turn, profile, provider: adapter, model }) => ({ turn, profile, adapter, model }))).toEqual([
      { turn: 1, profile: "default", adapter: "fake", model: "fake/model" },
      { turn: 2, profile: "second", adapter: "anthropic", model: "anthropic/claude-test" },
    ]);
    expect(steps[1]?.agentVersion).toBe(switched.agent.version);
    expect(provider.requests.at(-1)?.config.adapter).toBe("anthropic");
  });

  it("refuses a profile that setup does not have", async () => {
    const answer = await save({ profile: "missing" });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: { code: "playground.profileUnknown" } });
  });
});

describe("Provider Tools", () => {
  it("records a Provider Tool call apart from a Harness Tool call", async () => {
    await decode(await save({ profile: "second", webSearch: true }));
    await run("Use the shop_hours Tool and tell me when the sample shop opens on Saturday.");
    const entries = await run(SEARCH);
    expect(entries).toContainEvent({ type: "server_tool.called", name: "web_search" });
    expect(entries).toContainEvent({ type: "server_tool.result", name: "web_search" });
    expect(provider.requests.at(-1)?.providerTools).toEqual({ tools: ["web_search"], maxCalls: 2 });

    const { calls, usage } = await state();
    expect(calls.map(({ name, runsAt }) => ({ name, runsAt }))).toEqual([
      { name: "shop_hours", runsAt: "harness" },
      { name: "web_search", runsAt: "provider" },
    ]);
    expect(calls[1]?.result).toContain("developers.cloudflare.com");
    expect(usage.at(-1)).toMatchObject({ serverToolCalls: 1 });
  });

  it("refuses the grant on a profile that does not support the Provider Tool", async () => {
    const answer = await save({ profile: "default", webSearch: true });
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({
      error: { issues: expect.arrayContaining([expect.objectContaining({ code: "capability.unavailable" })]) },
    });
  });

  it("removes a denied Provider Tool from the request", async () => {
    await decode(await save({ profile: "second", webSearch: true, policy: "deny" }));
    const entries = await run(SEARCH);
    expect(entries).not.toContainEvent({ type: "server_tool.called" });
    expect(provider.requests.at(-1)?.providerTools?.tools).toEqual([]);
  });

  it("rejects an ask rule for a Provider Tool and keeps the stored version", async () => {
    const before = await decode(await save({ profile: "second", webSearch: true, policy: "allow" }));
    const answer = await save({ profile: "second", webSearch: true, policy: "ask" });
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({
      error: { issues: expect.arrayContaining([expect.objectContaining({ code: "policy.ask-on-provider-tool" })]) },
    });
    expect((await state()).agent).toMatchObject({ version: before.agent.version, settings: { policy: "allow" } });
  });
});

describe("AI Gateway", () => {
  it("sends the calls of the gateway profile with its gateway, and shows the log id without a cost", async () => {
    await decode(await save({ profile: "gateway" }));
    await run("Which model?");
    expect(provider.requests.at(-1)?.config).toMatchObject({
      adapter: "ai-sdk",
      gateway: { kind: "cloudflare", accountId: "test-account", gatewayId: "playground" },
    });
    const { usage } = await state();
    expect(usage).toEqual([
      expect.objectContaining({ profile: "gateway", gateway: { provider: "cloudflare", id: expect.any(String) } }),
    ]);
    expect(usage[0]?.cost).toBeUndefined();
  });
});

describe("reset", () => {
  it("starts a new Thread on the default profile without the Provider Tool", async () => {
    const before = await state();
    await decode(await save({ profile: "second", webSearch: true }));
    await run(SEARCH);
    const after = await decode(await api("POST", `${PATH}/reset`));
    expect(after.threadKey).not.toBe(before.threadKey);
    expect(after.agent.settings).toEqual({ profile: "default", webSearch: false, policy: "none" });
    expect(after.steps).toEqual([]);
    expect(after.calls).toEqual([]);
  });
});
