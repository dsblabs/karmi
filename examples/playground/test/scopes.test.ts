import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LIFECYCLE, PROFILE } from "../src/lifecycle";
import { api as request, events } from "./client";
import { karmi, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${LIFECYCLE}`;
const SECRET = "sk-scope-secret-4711";

const credentialUse = z.object({ ref: z.string(), source: z.string(), version: z.number() });

const stateSchema = z.object({
  threadKey: z.string(),
  scopeId: z.string(),
  scope: z.object({ id: z.string(), state: z.string(), configRevision: z.number() }),
  destroy: z.nullable(
    z.object({
      operationId: z.string(),
      state: z.string(),
      progress: z.object({ phase: z.string(), threads: z.number() }),
    }),
  ),
  profile: z.nullable(z.looseObject({ credential: z.string(), fallback: z.optional(z.unknown()) })),
  fallback: z.boolean(),
  credential: z.nullable(z.object({ version: z.number(), revokedAt: z.optional(z.number()) })),
  test: z.nullable(
    z.object({
      ok: z.boolean(),
      credential: z.optional(credentialUse),
      error: z.optional(z.object({ code: z.string(), message: z.string() })),
    }),
  ),
  keyring: z.nullable(z.object({ active: z.string(), keys: z.array(z.string()) })),
  rewrap: z.nullable(z.record(z.string(), z.number())),
  steps: z.array(
    z.object({
      seq: z.number(),
      profile: z.optional(z.string()),
      credential: z.optional(credentialUse),
      fallback: z.optional(z.object({ from: z.string(), reason: z.string() })),
    }),
  ),
  turn: z.nullable(z.object({ state: z.string(), paused: z.optional(z.string()) })),
});

type State = z.infer<typeof stateSchema>;

/** Reads a scenario state from an answer. */
const decode = async (response: Response): Promise<State> => {
  expect(response.status).toBe(200);
  return stateSchema.parse(await response.json());
};

const state = async () => decode(await api("GET", PATH));
const act = async (action: string, body?: unknown) => decode(await api("POST", `${PATH}/${action}`, body));

/** Sends one message to the Thread of the disposable Scope through the public route. */
async function send(now: State, text = "Say hello."): Promise<Response> {
  return api("POST", `/threads/${now.threadKey}/turns?scope=${now.scopeId}`, {
    kind: "message",
    parts: [{ type: "text", text }],
  });
}

/** The current disposable Scope of the MCP scenario. The rewrap covers it too. */
const mcpScope = async () =>
  z.object({ scopeId: z.string() }).parse(await (await api("GET", "/api/scenarios/mcp")).json()).scopeId;

const log = (now: State) => events(now.threadKey, now.scopeId);
const ends = (entries: ThreadEvent[]) =>
  entries.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length;

/** Sends one message and returns the log after its Turn ends. */
async function run(now: State): Promise<ThreadEvent[]> {
  const before = ends(await log(now));
  expect((await send(now)).status).toBe(202);
  let entries: ThreadEvent[] = [];
  await expect.poll(async () => ends((entries = await log(now))), { timeout: 10_000 }).toBe(before + 1);
  return entries;
}

beforeEach(async () => {
  provider.script(() => "Hello.");
  await api("POST", `${PATH}/reset`);
});

describe("the starting state", () => {
  it("has an active disposable Scope with a profile for the Scope credential and a fallback", async () => {
    const now = await state();
    expect(now.scopeId).toMatch(/^sample-lifecycle-\d+$/);
    expect(now.scope).toMatchObject({ id: now.scopeId, state: "active" });
    expect(now.profile).toMatchObject({ credential: "scope:provider", fallback: { profile: "default" } });
    expect(now.fallback).toBe(true);
    expect(now.credential).toBeNull();
    expect(now.destroy).toBeNull();
    expect(now.keyring).toEqual({ active: "v2", keys: ["v1", "v2"] });
  });

  it("runs a Turn under the Deployment profile while the Scope has no credential", async () => {
    const entries = await run(await state());
    expect(entries).toContainEvent({ type: "turn.completed" });
    const { steps } = await state();
    expect(steps).toEqual([expect.objectContaining({ fallback: { from: PROFILE, reason: "missing" } })]);
  });

  it("opens the Thread routes of the disposable Scope with the access token only", async () => {
    const now = await state();
    expect((await api("GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(200);
    expect((await request(null, "GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(401);
    expect((await api("GET", `/threads/${now.threadKey}?scope=sample-lifecycle-x`)).status).toBe(401);
    // A reset moves to a new Scope. The token no longer opens the old one.
    await act("reset");
    expect((await api("GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(401);
  });
});

describe("suspension", () => {
  it("parks a new Turn until the Scope resumes, then the Turn continues", async () => {
    const suspended = await act("suspend");
    expect(suspended.scope.state).toBe("suspended");
    expect((await send(suspended)).status).toBe(202);
    await expect
      .poll(async () => (await state()).turn, { timeout: 10_000 })
      .toEqual({ state: "parked", paused: "scope_suspended" });
    expect(await log(suspended)).toContainEvent({ type: "turn.paused", reason: "scope_suspended" });

    const resumed = await act("resume");
    expect(resumed.scope.state).toBe("active");
    await expect.poll(async () => ends(await log(resumed)), { timeout: 10_000 }).toBe(1);
    const entries = await log(resumed);
    expect(entries).toContainEvent({ type: "turn.resumed" });
    expect(entries).toContainEvent({ type: "turn.completed" });
  });

  it("keeps the credential and the Threads of the Scope", async () => {
    await act("credential", { value: SECRET });
    await run(await state());
    await act("suspend");
    const resumed = await act("resume");
    expect(resumed.credential?.version).toBe(1);
    expect(await log(resumed)).toContainEvent({ type: "turn.completed" });
  });
});

describe("destruction", () => {
  it("tombstones the Scope, reports the Destroy walk and refuses each later operation", async () => {
    await act("credential", { value: SECRET });
    const before = await state();
    await run(before);
    const destroying = await act("destroy");
    expect(destroying.destroy?.operationId).toEqual(expect.any(String));
    expect(["destroying", "destroyed"]).toContain(destroying.scope.state);
    await expect.poll(async () => (await state()).destroy?.state, { timeout: 10_000 }).toBe("destroyed");
    const destroyed = await state();
    expect(destroyed.scope.state).toBe("destroyed");
    expect(destroyed.destroy?.progress).toMatchObject({ phase: "done", threads: 1 });
    expect(destroyed.credential).toBeNull();

    // The walk deleted the Thread, thus its key finds a Thread tombstone. Each Scope operation finds the Scope one.
    const refused = await send(destroyed);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: "thread.deleted" } });
    const resume = await api("POST", `${PATH}/resume`);
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ error: { code: "scope.destroyed" } });
  });

  it("gives a reset a new Scope identity and leaves the tombstone", async () => {
    const first = await state();
    await act("destroy");
    const next = await act("reset");
    expect(next.scopeId).not.toBe(first.scopeId);
    expect(next.scope.state).toBe("active");
    expect(next.destroy).toBeNull();
    expect((await karmi.scope(first.scopeId).status()).state).toMatch(/^destroy/);
    expect(await run(next)).toContainEvent({ type: "turn.completed" });
  });

  it("destroys a disposable Scope that is still active on a reset", async () => {
    const first = await state();
    await act("credential", { value: SECRET });
    await act("reset");
    expect((await karmi.scope(first.scopeId).status()).state).toMatch(/^destroy/);
  });
});

describe("the Scope credential", () => {
  it("stores the value write-only, and no answer or event returns it", async () => {
    const response = await api("POST", `${PATH}/credential`, { value: SECRET });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(SECRET);
    const stored = stateSchema.parse(JSON.parse(text));
    expect(stored.credential).toMatchObject({ version: 1 });
    expect(stored.credential?.revokedAt).toBeUndefined();

    const entries = await run(stored);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect(JSON.stringify(await state())).not.toContain(SECRET);
    const { steps } = await state();
    expect(steps).toEqual([
      expect.objectContaining({ profile: PROFILE, credential: { ref: "scope:provider", source: "scope", version: 1 } }),
    ]);
    expect(steps[0]?.fallback).toBeUndefined();
  });

  it("refuses a body without a value", async () => {
    const response = await api("POST", `${PATH}/credential`, { value: "" });
    expect(response.status).toBe(400);
    expect((await state()).credential).toBeNull();
  });

  it("passes a test with the stored version", async () => {
    await act("credential", { value: SECRET });
    const tested = await act("test");
    expect(tested.test).toMatchObject({ ok: true, credential: { ref: "scope:provider", version: 1 } });
  });

  it("is missing from the next Step after a revocation, and the Step falls back", async () => {
    await act("credential", { value: SECRET });
    await run(await state());
    const revoked = await act("revoke");
    expect(revoked.credential?.revokedAt).toEqual(expect.any(Number));
    expect((await act("test")).test).toMatchObject({ ok: false, error: { code: "auth" } });

    await run(revoked);
    const { steps } = await state();
    expect(steps.map((step) => step.fallback)).toEqual([undefined, { from: PROFILE, reason: "missing" }]);
  });

  it("fails the next Turn after a revocation when the fallback is off", async () => {
    await act("credential", { value: SECRET });
    const off = await act("fallback", { on: false });
    expect(off.fallback).toBe(false);
    expect(off.profile?.fallback).toBeUndefined();
    await act("revoke");
    const entries = await run(off);
    expect(entries).toContainEvent({ type: "turn.failed" });
    expect(JSON.stringify(entries.find((event) => event.type === "turn.failed"))).toContain("scope:provider");
    expect((await act("fallback", { on: true })).fallback).toBe(true);
  });

  it("stores a new version that the next Step uses", async () => {
    await act("credential", { value: SECRET });
    await act("revoke");
    const replaced = await act("credential", { value: `${SECRET}-2` });
    expect(replaced.credential).toMatchObject({ version: 2 });
    expect(replaced.credential?.revokedAt).toBeUndefined();
    await run(replaced);
    expect((await state()).steps.at(-1)?.credential).toMatchObject({ version: 2 });
  });
});

describe("the key ring", () => {
  it("rewraps the credentials of each Scope of the Playground and keeps them usable", async () => {
    await act("credential", { value: SECRET });
    const now = await act("rewrap");
    // The in-memory store of the Test kit encrypts nothing, thus it rewraps nothing. The browser checks use the
    // envelope store, which counts the credential.
    expect(now.rewrap).toEqual({ [now.scopeId]: 0, "sample-a": 0, "sample-b": 0, [await mcpScope()]: 0 });
    expect((await act("test")).test).toMatchObject({ ok: true, credential: { version: 1 } });
  });

  it("still rewraps the sample Scopes after the disposable Scope is destroyed", async () => {
    await act("destroy");
    expect((await act("rewrap")).rewrap).toEqual({ "sample-a": 0, "sample-b": 0, [await mcpScope()]: 0 });
  });
});

describe("the reset of the scenario", () => {
  it("removes the scenario data and keeps the Provider setup and each other scenario", async () => {
    await act("credential", { value: SECRET });
    await act("test");
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    const next = await act("reset");
    expect(next.credential).toBeNull();
    expect(next.test).toBeNull();
    expect(next.rewrap).toBeNull();
    expect(next.steps).toEqual([]);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
    expect(await (await api("GET", "/api/playground")).json()).toMatchObject({
      provider: { id: "openrouter", model: "test/model" },
    });
  });
});
