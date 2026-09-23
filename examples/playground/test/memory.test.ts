import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CONCIERGE, MEMORY, OTHER_SCOPE, SCOPE } from "../src/app";
import { api as request, events } from "./client";
import { conciergeReplies } from "./script";
import { provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${MEMORY}`;

const memorySchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  notes: z.array(z.object({ id: z.number(), text: z.string(), agent: z.string(), at: z.number() })),
});

const scopeSchema = z.object({
  id: z.string(),
  threadKey: z.string(),
  threads: z.array(z.object({ threadKey: z.string(), threadId: z.string(), state: z.string() })),
  memory: memorySchema,
  users: z.array(z.string()),
});

const stateSchema = z.object({
  threadKey: z.string(),
  user: z.string(),
  scopes: z.tuple([scopeSchema, scopeSchema]),
  fields: z.record(z.string(), z.unknown()),
});

type State = z.infer<typeof stateSchema>;

/** Reads the state of the scenario through its route. */
const state = async (): Promise<State> => stateSchema.parse(await (await api("GET", PATH)).json());

/** The part of the state for one sample Scope. */
const inScope = (now: State, id: string) => now.scopes.find((scope) => scope.id === id) ?? now.scopes[0];

/** The query that selects the sample Scope of a public Thread route. Absent for the first sample Scope. */
const scoped = (path: string, scope: string) => (scope === SCOPE ? path : `${path}?scope=${scope}`);

/** Reads the log of a Thread in one sample Scope through the public route. */
async function read(key: string, scope: string): Promise<ThreadEvent[]> {
  const value: unknown = await (await api("GET", scoped(`/threads/${key}/events`, scope))).json();
  return Array.isArray(value) ? (value as ThreadEvent[]) : [];
}

const turns = (log: ThreadEvent[]) => log.filter((event) => event.type === "turn.completed").length;

/** Sends one message to the current Thread of `scope` and returns the log after the Turn completes. */
async function run(scope: string, text: string): Promise<ThreadEvent[]> {
  const key = inScope(await state(), scope).threadKey;
  const before = turns(await read(key, scope));
  const sent = await api("POST", scoped(`/threads/${key}/turns`, scope), {
    kind: "message",
    parts: [{ type: "text", text }],
  });
  expect(sent.status).toBe(202);
  let log: ThreadEvent[] = [];
  await expect.poll(async () => turns((log = await read(key, scope))), { timeout: 10_000 }).toBe(before + 1);
  return log;
}

/** The final answer of the Agent in a log. */
const answer = (log: ThreadEvent[]) =>
  log
    .filter((event) => event.type === "message.part")
    .map((event) => (event.block.type === "text" ? event.block.text : ""))
    .at(-1);

const REMEMBER = "I like a dark roast. Please remember that.";
const ASK = "Which roast do I like?";

beforeEach(async () => {
  provider.script(conciergeReplies);
  await api("POST", `${PATH}/reset`);
});

describe("the state of the scenario", () => {
  it("starts with one Thread and no Memory in each sample Scope", async () => {
    const now = await state();
    expect(now.user).toBe("operator");
    expect(now.scopes.map((scope) => scope.id)).toEqual([SCOPE, OTHER_SCOPE]);
    expect(now.threadKey).toBe(now.scopes[0].threadKey);
    for (const scope of now.scopes) {
      expect(scope.threads).toHaveLength(1);
      expect(scope.threads[0]?.threadKey).toBe(scope.threadKey);
      expect(scope.threads[0]?.threadId.startsWith(`${CONCIERGE}-`)).toBe(true);
      expect(scope.memory).toEqual({ profile: {}, notes: [] });
      expect(scope.users).toEqual([]);
    }
    expect(now.fields).toHaveProperty("roast");
  });
});

describe("a remembered preference", () => {
  it("is stored by the remember Tool and shown by the scenario", async () => {
    const log = await run(SCOPE, REMEMBER);
    expect(log).toContainEvent({ type: "tool.call", name: "remember" });
    expect(log).toContainEvent({ type: "tool.result", name: "remember", isError: false });
    expect(answer(log)).toBe("I will remember that.");
    const { memory, users } = inScope(await state(), SCOPE);
    expect(memory.profile).toEqual({ roast: "dark" });
    expect(memory.notes).toEqual([
      expect.objectContaining({ text: "Collects the order on Fridays.", agent: CONCIERGE }),
    ]);
    expect(users).toEqual(["operator"]);
  });

  it("reaches a new Thread of the same User through the Memory Fragment", async () => {
    await run(SCOPE, REMEMBER);
    const first = inScope(await state(), SCOPE).threadKey;
    const started = await api("POST", `${PATH}/thread`, { scope: SCOPE });
    expect(started.status).toBe(200);
    const next = inScope(stateSchema.parse(await started.json()), SCOPE);
    expect(next.threadKey).not.toBe(first);
    expect(next.threads.map((thread) => thread.threadKey)).toEqual([first, next.threadKey]);
    // The earlier Thread stays. The new Thread has no event of it.
    expect(await events(first)).not.toEqual([]);
    expect(await events(next.threadKey)).toEqual([]);

    const log = await run(SCOPE, ASK);
    expect(answer(log)).toBe("You like a dark roast.");
    const system = provider.requests.at(-1)?.system ?? "";
    expect(system).toContain("# Memory");
    expect(system).toContain('roast: "dark"');
    expect(system).toContain("Collects the order on Fridays.");
    // The answer came from the Fragment, not from a Tool call.
    expect(log.filter((event) => event.type === "tool.call")).toEqual([]);
  });

  it("is found by the recall Tool", async () => {
    await run(SCOPE, REMEMBER);
    await api("POST", `${PATH}/thread`, { scope: SCOPE });
    const log = await run(SCOPE, "Search your notes for my collection day.");
    expect(log).toContainEvent({ type: "tool.call", name: "recall", input: { query: "Fridays" } });
    const result = log.find((event) => event.type === "tool.result" && event.name === "recall");
    expect(JSON.stringify(result)).toContain("Collects the order on Fridays.");
    expect(answer(log)).toContain("Collects the order on Fridays.");
  });

  it("is gone after a delete, and the next Thread does not know it", async () => {
    await run(SCOPE, REMEMBER);
    const forgotten = await api("POST", `${PATH}/forget`, { scope: SCOPE });
    expect(forgotten.status).toBe(200);
    const after = inScope(stateSchema.parse(await forgotten.json()), SCOPE);
    expect(after.memory).toEqual({ profile: {}, notes: [] });
    expect(after.users).toEqual([]);
    await api("POST", `${PATH}/thread`, { scope: SCOPE });
    const log = await run(SCOPE, ASK);
    expect(answer(log)).toBe("I do not know your preferences yet.");
    expect(provider.requests.at(-1)?.system).toContain("Nothing is known about this user yet.");
  });
});

describe("the second sample Scope", () => {
  it("has its own Memory of the same User, which the first Scope cannot see", async () => {
    await run(SCOPE, REMEMBER);
    const log = await run(OTHER_SCOPE, ASK);
    expect(answer(log)).toBe("I do not know your preferences yet.");
    const now = await state();
    expect(inScope(now, SCOPE).memory.profile).toEqual({ roast: "dark" });
    expect(inScope(now, OTHER_SCOPE).memory).toEqual({ profile: {}, notes: [] });
    expect(inScope(now, OTHER_SCOPE).users).toEqual([]);

    await run(OTHER_SCOPE, "I like a light roast. Please remember that.");
    const later = await state();
    expect(inScope(later, OTHER_SCOPE).memory.profile).toEqual({ roast: "light" });
    expect(inScope(later, SCOPE).memory.profile).toEqual({ roast: "dark" });
  });

  it("is not reachable with the key of its Thread through the first Scope", async () => {
    await run(OTHER_SCOPE, REMEMBER);
    const key = inScope(await state(), OTHER_SCOPE).threadKey;
    expect((await api("GET", `/threads/${key}`)).status).toBe(404);
    expect((await api("GET", `/threads/${key}/events`)).status).toBe(404);
    expect((await api("GET", `/threads/${key}?scope=${OTHER_SCOPE}`)).status).toBe(200);
    // The token opens the two sample Scopes only.
    expect((await api("GET", `/threads/${key}?scope=sample-c`)).status).toBe(401);
  });

  it("refuses a new Thread or a delete in a Scope that is not a sample Scope", async () => {
    expect((await api("POST", `${PATH}/thread`, { scope: "sample-c" })).status).toBe(400);
    expect((await api("POST", `${PATH}/forget`, {})).status).toBe(400);
  });
});

describe("the reset of the scenario", () => {
  it("deletes each Thread and each Memory of both Scopes, and keeps the Provider setup", async () => {
    await run(SCOPE, REMEMBER);
    await api("POST", `${PATH}/thread`, { scope: SCOPE });
    await run(OTHER_SCOPE, REMEMBER);
    const before = await state();
    const after = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    for (const scope of after.scopes) {
      const earlier = inScope(before, scope.id);
      expect(scope.threadKey).not.toBe(earlier.threadKey);
      expect(scope.threads).toHaveLength(1);
      expect(scope.memory).toEqual({ profile: {}, notes: [] });
      expect(scope.users).toEqual([]);
      for (const thread of earlier.threads)
        expect((await api("GET", scoped(`/threads/${thread.threadKey}`, scope.id))).status).toBe(404);
    }
    expect(await (await api("GET", "/api/playground")).json()).toMatchObject({
      provider: { id: "openrouter", model: "test/model" },
    });
  });

  it("does not change the refund scenario", async () => {
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    await api("POST", `${PATH}/reset`);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
  });
});
