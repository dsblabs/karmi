import type { ThreadEvent } from "@karmi/core";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP, oauthSetup } from "../src/remote-mcp";
import { api as request, events } from "./client";
import { board, drive, keyed, KEYED_SECRET, vault } from "./mcp-servers";
import { mcpReplies } from "./script";
import { karmi, ORIGIN, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${MCP}`;

const stateSchema = z.object({
  threadKey: z.string(),
  scopeId: z.string(),
  oauth: z.object({ available: z.boolean(), reason: z.optional(z.string()) }),
  server: z.nullable(
    z.object({
      id: z.string(),
      config: z.looseObject({ url: z.string(), auth: z.looseObject({ type: z.string() }) }),
      hosts: z.array(z.string()),
    }),
  ),
  missing: z.nullable(z.string()),
  catalog: z.nullable(
    z.object({
      version: z.string(),
      cacheScope: z.string(),
      era: z.string(),
      tools: z.array(z.object({ name: z.string(), annotations: z.optional(z.unknown()) })),
    }),
  ),
  credential: z.nullable(z.object({ reference: z.string(), version: z.number(), revokedAt: z.optional(z.number()) })),
  connection: z.nullable(z.object({ name: z.string(), updatedAt: z.number() })),
  discovery: z.nullable(
    z.object({ ok: z.boolean(), error: z.optional(z.object({ code: z.string(), message: z.string() })) }),
  ),
  policy: z.array(z.unknown()),
  turn: z.object({ state: z.string(), paused: z.optional(z.string()) }),
});

type State = z.infer<typeof stateSchema>;

const decode = async (response: Response): Promise<State> => {
  expect(response.status).toBe(200);
  return stateSchema.parse(await response.json());
};

const state = async () => decode(await api("GET", PATH));
const act = async (action: string, body?: unknown) => decode(await api("POST", `${PATH}/${action}`, body));
const register = (url: string, options: Record<string, unknown> = {}) =>
  act("register", { url, auth: "none", trustAnnotations: false, ...options });

/** Sends one message to the Thread of the disposable Scope through the public route. */
async function send(now: State, text = "Use one Tool of the remote server that reads data."): Promise<Response> {
  return api("POST", `/threads/${now.threadKey}/turns?scope=${now.scopeId}`, {
    kind: "message",
    parts: [{ type: "text", text }],
  });
}

const log = (now: State) => events(now.threadKey, now.scopeId);
const settled = (entries: ThreadEvent[]) =>
  entries.filter(
    (event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused",
  ).length;

/** Sends one message and returns the log after its Turn ends or parks. */
async function run(now: State): Promise<ThreadEvent[]> {
  const before = settled(await log(now));
  expect((await send(now)).status).toBe(202);
  let entries: ThreadEvent[] = [];
  await expect.poll(async () => settled((entries = await log(now))), { timeout: 10_000 }).toBeGreaterThan(before);
  return entries;
}

/** Waits until the log of the Thread has one more end of a Turn than `entries`. */
async function next(now: State, entries: ThreadEvent[]): Promise<ThreadEvent[]> {
  const before = settled(entries);
  let later: ThreadEvent[] = [];
  await expect.poll(async () => settled((later = await log(now))), { timeout: 10_000 }).toBeGreaterThan(before);
  return later;
}

/** The last event of a type, narrowed to that type. */
function last<Type extends ThreadEvent["type"]>(entries: ThreadEvent[], type: Type) {
  return entries.findLast((event): event is Extract<ThreadEvent, { type: Type }> => event.type === type);
}

/** The text of the last Tool result in the log. */
const resultText = (entries: ThreadEvent[]) =>
  last(entries, "tool.result")
    ?.content.map((block) => ("text" in block ? block.text : ""))
    .join(" ");

/**
 * Plays the operator at the consent page: the fake authorization server answers, and the browser follows the
 * redirect to the callback of the Playground. The callback needs no access token. The answer is not followed.
 */
function consent(server: typeof vault, authUrl: string, allow = true): Promise<Response> {
  const oauth = server.oauth;
  if (!oauth) throw new Error("The fake server has no OAuth.");
  return SELF.fetch(allow ? oauth.approve(authUrl) : oauth.deny(authUrl), { redirect: "manual" });
}

/** Starts the consent flow from the Connection card and returns the URL of the consent page. */
async function connectUrl(): Promise<string> {
  return z.object({ authUrl: z.string() }).parse(await (await api("POST", `${PATH}/connect`)).json()).authUrl;
}

beforeEach(async () => {
  provider.script(mcpReplies);
  await api("POST", `${PATH}/reset`);
});

describe("the starting state", () => {
  it("has a disposable Scope with no server and shows the prerequisites of the scenario", async () => {
    const now = await state();
    expect(now.scopeId).toMatch(/^sample-mcp-\d+$/);
    expect(now.server).toBeNull();
    expect(now.catalog).toBeNull();
    expect(now.oauth).toEqual({ available: true });
    const playground = z
      .object({ scenarios: z.array(z.looseObject({ id: z.string(), prerequisites: z.array(z.string()) })) })
      .parse(await (await api("GET", "/api/playground")).json());
    const scenario = playground.scenarios.find((item) => item.id === MCP);
    expect(scenario).toMatchObject({ built: true, status: "ready" });
    expect(scenario?.prerequisites.join(" ")).toMatch(/https URL.*header value.*PLAYGROUND_ORIGIN/s);
  });

  it("runs a Turn before a registration, and the Agent has no Tool of the server", async () => {
    const done = await run(await state());
    expect(done.map((event) => event.type)).not.toContain("tool.call");
    expect(last(done, "turn.completed")).toBeDefined();
  });

  it("opens the Thread routes of the disposable Scope with the access token only", async () => {
    const now = await state();
    expect((await api("GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(200);
    expect((await request(null, "GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(401);
    await act("reset");
    expect((await api("GET", `/threads/${now.threadKey}?scope=${now.scopeId}`)).status).toBe(401);
  });
});

describe("a server with no credential", () => {
  it("registers the server with its host as the only permitted host and lists its Tools", async () => {
    const now = await register(board.url);
    expect(now.server).toMatchObject({ id: "remote", config: { url: board.url, auth: { type: "none" } } });
    expect(now.server?.hosts).toEqual(["board.mcp.test"]);
    expect(now.discovery).toMatchObject({ ok: true });
    expect(now.catalog?.tools.map((tool) => tool.name)).toEqual(["read_notice", "post_notice"]);
    expect(now.catalog).toMatchObject({ cacheScope: "public", era: "modern" });
  });

  it("asks for an Approval of each call without trustAnnotations, and allow runs the call", async () => {
    const now = await register(board.url);
    const parked = await run(now);
    const asked = last(parked, "approval.requested");
    expect(asked).toMatchObject({ kind: "tool", tool: "remote__read_notice" });
    if (!asked) return;
    expect(
      (
        await api("POST", `/threads/${now.threadKey}/approvals/${asked.seq}?scope=${now.scopeId}`, {
          decision: "allow",
        })
      ).status,
    ).toBe(204);
    const done = await next(now, parked);
    expect(resultText(done)).toBe("The shop opens at 9.");
    expect(last(done, "turn.completed")).toBeDefined();
  });

  it("allows a read-only call with trustAnnotations under the Policy of the Agent", async () => {
    const now = await register(board.url, { trustAnnotations: true });
    const done = await run(now);
    expect(done.map((event) => event.type)).not.toContain("approval.requested");
    expect(resultText(done)).toBe("The shop opens at 9.");
  });

  it("refuses a second registration in the same Scope", async () => {
    await register(board.url);
    const response = await api("POST", `${PATH}/register`, { url: keyed.url, auth: "none" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "playground.serverRegistered" } });
    expect((await state()).server?.config.url).toBe(board.url);
  });
});

describe("failed and refused connections", () => {
  it("refuses a private address at registration", async () => {
    const response = await api("POST", `${PATH}/register`, { url: "https://10.0.0.8/mcp", auth: "none" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "config.invalid" } });
    expect((await state()).server).toBeNull();
  });

  it("refuses a body that is not a registration", async () => {
    expect((await api("POST", `${PATH}/register`, { url: "not a url", auth: "none" })).status).toBe(400);
    expect((await api("POST", `${PATH}/register`, { url: keyed.url, auth: "static" })).status).toBe(400);
  });

  it("reports a failed tool list when the server refuses the credential, without the value", async () => {
    const now = await register(keyed.url, { auth: "static", header: "Authorization", value: "Bearer wrong" });
    expect(now.discovery).toMatchObject({ ok: false, error: { code: "mcp.discovery.failed" } });
    expect(now.catalog).toBeNull();
    // With no tool list, the Turn offers no Tool of the server.
    const done = await run(now);
    expect(done.map((event) => event.type)).not.toContain("tool.call");
    expect(JSON.stringify([now, done])).not.toContain("Bearer wrong");
  });
});

describe("a static credential", () => {
  it("stores the header value write-only, and a revoked credential makes the next tool list fail", async () => {
    const response = await api("POST", `${PATH}/register`, {
      url: keyed.url,
      auth: "static",
      header: "Authorization",
      value: KEYED_SECRET,
      trustAnnotations: true,
    });
    const text = await response.text();
    expect(text).not.toContain(KEYED_SECRET);
    const now = stateSchema.parse(JSON.parse(text));
    expect(now.server?.config.auth).toEqual({ type: "static", headers: { Authorization: "scope:mcp-remote" } });
    expect(now.credential).toMatchObject({ reference: "scope:mcp-remote", version: 1 });
    expect(now.catalog?.tools.map((tool) => tool.name)).toEqual(["read_notice"]);
    const done = await run(now);
    expect(resultText(done)).toBe("The keyed board says hello.");
    expect(JSON.stringify(done)).not.toContain(KEYED_SECRET);

    const revoked = await act("revoke");
    expect(revoked.credential?.revokedAt).toEqual(expect.any(Number));
    expect(revoked.missing).toBe("scope:mcp-remote");
    const listed = await act("discover");
    expect(listed.discovery).toMatchObject({ ok: false, error: { message: expect.stringContaining("missing") } });
    expect(JSON.stringify(await state())).not.toContain(KEYED_SECRET);
  });
});

describe("an OAuth Connection", () => {
  it("connects from the page, lists the Tools and runs a call with the grant of the User", async () => {
    const now = await register(vault.url, { auth: "oauth", trustAnnotations: true });
    expect(now.server?.config.auth).toEqual({ type: "oauth", level: "user" });
    expect(now.connection).toBeNull();
    expect(now.discovery).toBeNull();

    const back = await consent(vault, await connectUrl());
    // The callback stores the grant and sends the browser back to the scenario.
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/?mcp=remote&connected=true#${MCP}`);
    const connected = await act("discover");
    expect(connected.connection).toMatchObject({ name: "mcp:remote" });
    expect(connected.catalog?.tools.map((tool) => tool.name)).toEqual(["read_notice"]);
    expect(resultText(await run(connected))).toBe("The vault holds 3 files.");
  });

  it("asks for the missing Connection in the conversation and continues the call after OAuth", async () => {
    const now = await register(vault.url, { auth: "oauth", trustAnnotations: true });
    await consent(vault, await connectUrl());
    await act("discover");
    // A disconnect removes the grant. The tool list of this server is public, thus the Turn still offers the Tools.
    const disconnected = await act("disconnect");
    expect(disconnected.connection).toBeNull();
    expect(disconnected.catalog?.cacheScope).toBe("public");

    const parked = await run(now);
    const asked = last(parked, "approval.requested");
    expect(asked).toMatchObject({ kind: "connect", serverId: "remote", level: "user", tool: "remote__read_notice" });
    if (asked?.kind !== "connect") return;
    expect((await state()).turn).toEqual({ state: "parked", paused: "approval" });

    const answer = await consent(vault, asked.authUrl);
    expect(answer.status).toBe(200);
    const done = await next(now, parked);
    expect(last(done, "approval.resolved")).toMatchObject({ kind: "connect", decision: "allow", by: "oauth" });
    expect(resultText(done)).toBe("The vault holds 3 files.");
    expect(last(done, "turn.completed")).toBeDefined();
    expect((await state()).connection).toMatchObject({ name: "mcp:remote" });
  });

  it("ends the call with an error result when the operator denies the consent", async () => {
    const now = await register(vault.url, { auth: "oauth", trustAnnotations: true });
    await consent(vault, await connectUrl());
    await act("discover");
    await act("disconnect");
    const parked = await run(now);
    const asked = last(parked, "approval.requested");
    if (asked?.kind !== "connect") throw new Error("expected a connect Approval");
    expect((await consent(vault, asked.authUrl, false)).status).toBe(400);
    const done = await next(now, parked);
    expect(last(done, "approval.resolved")).toMatchObject({ kind: "connect", decision: "deny" });
    expect(last(done, "tool.result")).toMatchObject({ isError: true });
    expect(resultText(done)).toContain("connection not granted");
    expect((await state()).connection).toBeNull();
  });

  it("asks for the Connection again when the server revokes the grant, and keeps the private tool list", async () => {
    const now = await register(drive.url, { auth: "oauth", trustAnnotations: true });
    await consent(drive, await connectUrl());
    const listed = await act("discover");
    expect(listed.catalog).toMatchObject({ cacheScope: "private", era: "legacy" });
    expect(resultText(await run(listed))).toBe("The drive holds 2 files.");

    // The authorization server refuses the access token and the refresh token. karmi drops the dead grant.
    drive.oauth?.revoke({ refresh: true });
    const parked = await run(now);
    const asked = last(parked, "approval.requested");
    if (asked?.kind !== "connect") throw new Error("expected a connect Approval");
    expect((await state()).connection).toBeNull();
    await consent(drive, asked.authUrl);
    expect(resultText(await next(now, parked))).toBe("The drive holds 2 files.");
  });

  it("refuses a Connection for a server without OAuth", async () => {
    await register(board.url);
    const response = await api("POST", `${PATH}/connect`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "mcp.oauth.notOAuth" } });
  });
});

describe("the reset of the scenario", () => {
  it("destroys the Scope with its registration, credential and Connection, and keeps the Provider setup", async () => {
    const first = await register(vault.url, { auth: "oauth" });
    await consent(vault, await connectUrl());
    expect((await state()).connection).not.toBeNull();
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();

    const reset = await act("reset");
    expect(reset.scopeId).not.toBe(first.scopeId);
    expect(reset.server).toBeNull();
    expect(reset.connection).toBeNull();
    expect(reset.discovery).toBeNull();
    expect((await karmi.scope(first.scopeId).status()).state).toMatch(/^destroy/);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
    expect(await (await api("GET", "/api/playground")).json()).toMatchObject({
      provider: { id: "openrouter", model: "test/model" },
    });
  });
});

describe("the OAuth origin", () => {
  it("takes an https origin and explains each other value", () => {
    expect(oauthSetup("https://karmi-playground.example.workers.dev/")).toEqual({
      origin: "https://karmi-playground.example.workers.dev",
    });
    expect(oauthSetup(undefined)).toEqual({ reason: expect.stringContaining("PLAYGROUND_ORIGIN") });
    expect(oauthSetup("http://localhost:8787")).toEqual({ reason: expect.stringContaining("https") });
    expect(oauthSetup("not a url")).toEqual({ reason: expect.stringContaining("https") });
  });
});
