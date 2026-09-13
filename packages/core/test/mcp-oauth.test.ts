import { beforeEach, describe, expect, it } from "vitest";
import {
  KarmiError,
  sensitive,
  type Scope,
  type ScopeConfigDocument,
  type Thread,
  type ThreadEvent,
} from "../src/index";
import { lastMessage, reply } from "../src/testing/index";
import { clock, crm, drive, karmi, locked, provider, secrets } from "./worker";

const CIMD = "https://karmi.test/.well-known/karmi-mcp-client.json";
const CALLBACK = "https://karmi.test/mcp/oauth/callback";
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const base: ScopeConfigDocument = {
  mcp: {
    servers: {
      drive: { url: drive.url, auth: { type: "oauth", level: "user", scope: "drive:read" }, trustAnnotations: true },
      crm: { url: crm.url, auth: { type: "oauth", level: "agent" } },
      locked: { url: locked.url, auth: { type: "oauth", level: "agent" } },
    },
  },
};

let n = 0;
/** A fresh Scope per test, so grants, registrations and catalogue caches never leak between them. */
async function fresh(patch: Partial<ScopeConfigDocument> = {}): Promise<Scope> {
  const scope = karmi.scope(`oauth-${++n}`);
  await scope.config.set({ ...base, ...patch });
  return scope;
}
const thread = (scope: Scope, agent: string, user: string | undefined, threadId: string) =>
  scope.thread(user === undefined ? { agent, threadId } : { agent, user, threadId });

async function settled(thread: Thread, text: string): Promise<ThreadEvent[]> {
  const { turn, seq } = await thread.send(message(text));
  return rest(thread, seq, turn);
}
/** Everything the Turn logs after `seq`, up to its end or next park. */
async function rest(thread: Thread, seq: number, turn?: number): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: seq })) {
    if (turn !== undefined && event.turn !== turn) continue;
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
  }
  return events;
}
const result = (events: ThreadEvent[], id: string) => events.find((e) => e.type === "tool.result" && e.id === id);
const requested = (events: ThreadEvent[]) => {
  const event = events.find((e) => e.type === "approval.requested");
  if (event?.type !== "approval.requested" || event.kind !== "connect") throw new Error("expected a connect request");
  return event;
};
const calls = (server: { calls: { method: string; headers: Record<string, string> }[] }, method: string) =>
  server.calls.filter((c) => c.method === method);
/** Plays the human: consents at the authorization server and lands on karmi's callback. */
const consent = async (server: typeof drive, authUrl: string) =>
  karmi.oauth.handle(new Request(server.oauth!.approve(authUrl)));
/** The settings-page path: authorize, consent, done. */
async function grant(scope: Scope, input: { serverId: string; agent?: string; user?: string }) {
  const server = input.serverId === "drive" ? drive : input.serverId === "crm" ? crm : locked;
  const { authUrl } = await scope.mcp.authorize(input);
  const response = await consent(server, authUrl);
  expect(response?.status).toBe(200);
}

beforeEach(() => {
  drive.reset();
  crm.reset();
  locked.reset();
});

describe("client identity", () => {
  it("serves the CIMD document at the fixed path, cacheable, with client_id equal to its own URL", async () => {
    const response = await karmi.oauth.handle(new Request(CIMD));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toContain("max-age");
    expect(await response?.json()).toEqual({
      client_id: CIMD,
      client_name: "karmi test",
      client_uri: "https://karmi.test",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(await karmi.oauth.handle(new Request("https://karmi.test/other"))).toBeUndefined();
  });

  it("refuses a client secret pasted into the config", async () => {
    const scope = karmi.scope(`oauth-${++n}`);
    await expect(
      scope.config.set({
        mcp: {
          servers: {
            locked: { url: locked.url, auth: { type: "oauth", level: "agent", client: { id: "x", secret: "s3cret" } } },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "config.secret-value" });
  });
});

describe("consent", () => {
  it("authorizes from a settings page with CIMD, PKCE, resource and iss, then calls with the bearer", async () => {
    const scope = await fresh();
    const { authUrl } = await scope.mcp.authorize({ serverId: "drive", user: "alice" });
    expect(new URL(authUrl).searchParams.get("state")).toMatch(new RegExp(`^${scope.id}\\.`));
    const response = await consent(drive, authUrl);
    expect(response?.status).toBe(200);
    expect(drive.oauth?.authorizations.at(-1)).toMatchObject({
      clientId: CIMD,
      redirectUri: CALLBACK,
      codeChallengeMethod: "S256",
      scope: "drive:read",
      resource: drive.url,
    });
    expect(drive.oauth?.tokenRequests).toEqual([
      { grantType: "authorization_code", clientId: CIMD, resource: drive.url },
    ]);
    expect(await scope.users.connections.list("alice")).toEqual([{ name: "mcp:drive", updatedAt: expect.any(Number) }]);

    provider.script([[reply.toolCall("drive__list_files", {}, "c1")], "Done"]);
    const events = await settled(thread(scope, "mcp-drive", "alice", "t1"), "list");
    expect(result(events, "c1")).toMatchObject({ isError: false, content: [{ type: "text", text: "a.txt, b.txt" }] });
    expect(lastMessage(events)).toBe("Done");
    expect(calls(drive, "tools/call")[0]?.headers.authorization).toBe(`Bearer ${drive.oauth?.tokens[0]}`);
    // The snapshot never carries the token in a loggable form.
    const snapshot = await scope.mcp.snapshot({ user: "alice", serverIds: ["drive"] });
    expect(snapshot.servers[0]?.oauth?.holder).toBe("user:alice");
    expect(() => JSON.stringify(snapshot.servers[0]?.oauth)).toThrowError(
      expect.objectContaining({ code: "secrets.exposed" }),
    );
  });

  it("parks a call on a connect Approval, resumes it when the User consents in-band, and binds the grant to that User", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    provider.script(["warm"]);
    await settled(thread(scope, "mcp-drive", "alice", "warm"), "warm");
    drive.reset();

    // Bob sees the tools through alice's public catalogue; his first call has no grant behind it.
    provider.script([[reply.toolCall("drive__list_files", {}, "c2")], "Listed"]);
    const bob = thread(scope, "mcp-drive", "bob", "t2");
    const parked = await settled(bob, "list");
    expect(parked).toHaveSequence([
      "step.started",
      "step.completed",
      "step.started",
      "tool.call",
      "approval.requested",
      "turn.paused",
    ]);
    const request = requested(parked);
    expect(request).toMatchObject({
      kind: "connect",
      id: "c2",
      tool: "drive__list_files",
      serverId: "drive",
      level: "user",
    });
    expect(request.timeoutAt - request.at).toBe(60 * 60 * 1000);
    expect(await bob.status()).toMatchObject({
      state: "parked",
      paused: "approval",
      pendingApprovals: [
        { seq: request.seq, kind: "connect", tool: "drive__list_files", serverId: "drive", authUrl: request.authUrl },
      ],
    });
    expect(calls(drive, "tools/call")).toHaveLength(0);

    const response = await consent(drive, request.authUrl);
    expect(response?.status).toBe(200);
    const resumed = await rest(bob, parked.at(-1)!.seq);
    expect(resumed).toHaveSequence([
      "approval.resolved",
      "turn.resumed",
      "tool.result",
      "step.completed",
      "step.started",
      "step.completed",
      "turn.completed",
    ]);
    expect(resumed).toContainEvent({
      type: "approval.resolved",
      request: request.seq,
      kind: "connect",
      tool: "drive__list_files",
      decision: "allow",
      by: "oauth",
      source: "answer",
    });
    expect(result(resumed, "c2")).toMatchObject({ isError: false, content: [{ type: "text", text: "a.txt, b.txt" }] });
    expect(calls(drive, "tools/call")[0]?.headers.authorization).toBe(`Bearer ${drive.oauth?.tokens.at(-1)}`);
    expect(await scope.users.connections.list("bob")).toEqual([{ name: "mcp:drive", updatedAt: expect.any(Number) }]);
  });

  it("answers a refused or timed-out connect with an isError result", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    provider.script(["warm"]);
    await settled(thread(scope, "mcp-drive", "alice", "warm"), "warm");

    provider.script([
      [reply.toolCall("drive__list_files", {}, "c1")],
      "Ok",
      [reply.toolCall("drive__list_files", {}, "c2")],
      "Ok",
    ]);
    const bob = thread(scope, "mcp-drive", "bob", "deny");
    const parked = await settled(bob, "list");
    // Only OAuth can grant; a hand-written allow is refused, a deny is an ordinary answer.
    await expect(bob.approve(requested(parked).seq, { decision: "allow" })).rejects.toMatchObject({
      code: "approval.invalid",
    });
    const denied = await karmi.oauth.handle(new Request(drive.oauth!.deny(requested(parked).authUrl)));
    expect(denied?.status).toBe(400);
    const resumed = await rest(bob, parked.at(-1)!.seq);
    expect(resumed).toContainEvent({ type: "approval.resolved", kind: "connect", decision: "deny", by: "oauth" });
    expect(result(resumed, "c1")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("connection not granted") }],
    });
    expect(lastMessage(resumed)).toBe("Ok");

    const carol = thread(scope, "mcp-drive", "carol", "timeout");
    const waiting = await settled(carol, "list");
    await clock.advance("1h");
    await clock.advance(1);
    const expired = await rest(carol, waiting.at(-1)!.seq);
    expect(expired).toContainEvent({ type: "approval.resolved", kind: "connect", decision: "deny", source: "timeout" });
    expect(result(expired, "c2")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("timed out") }],
    });
  });

  it("degrades a user-level server on a user-less Thread to connection.unavailable without asking", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    provider.script(["warm"]);
    await settled(thread(scope, "mcp-drive", "alice", "warm"), "warm");
    provider.script([[reply.toolCall("drive__list_files", {}, "c1")], "Ok"]);
    const events = await settled(thread(scope, "mcp-drive", undefined, "nobody"), "list");
    expect(events.map((e) => e.type)).not.toContain("approval.requested");
    expect(result(events, "c1")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("connection.unavailable") }],
    });
  });
});

describe("tokens", () => {
  it("refreshes an expiring token before the Turn and a refused one once mid-Turn, rotation-safe", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    const first = drive.oauth!.tokens[0];
    await clock.advance(3600 * 1000);
    provider.script([[reply.toolCall("drive__list_files", {}, "c1")], "Ok"]);
    await settled(thread(scope, "mcp-drive", "alice", "t1"), "list");
    expect(drive.oauth?.tokenRequests.at(-1)).toMatchObject({ grantType: "refresh_token", resource: drive.url });
    const second = drive.oauth!.tokens.at(-1);
    expect(second).not.toBe(first);
    expect(calls(drive, "tools/call")[0]?.headers.authorization).toBe(`Bearer ${second}`);

    // The server revokes the access token under a running Turn: one refresh, one retry, no human.
    drive.reset();
    drive.oauth?.revoke();
    provider.script([[reply.toolCall("drive__list_files", {}, "c2")], "Ok"]);
    const events = await settled(thread(scope, "mcp-drive", "alice", "t2"), "list");
    expect(result(events, "c2")).toMatchObject({ isError: false });
    expect(events.map((e) => e.type)).not.toContain("approval.requested");
    expect(calls(drive, "tools/call").map((c) => c.headers.authorization)).toEqual([
      `Bearer ${second}`,
      `Bearer ${drive.oauth?.tokens.at(-1)}`,
    ]);
  });

  it("asks for consent again when the refresh token is gone too, dropping the dead grant", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    provider.script(["warm"]);
    await settled(thread(scope, "mcp-drive", "alice", "warm"), "warm");
    drive.oauth?.revoke({ refresh: true });
    provider.script([[reply.toolCall("drive__list_files", {}, "c1")], "Ok"]);
    const parked = await settled(thread(scope, "mcp-drive", "alice", "t1"), "list");
    expect(requested(parked)).toMatchObject({ kind: "connect", serverId: "drive" });
    expect(await scope.users.connections.list("alice")).toEqual([]);
  });

  it("steps up on 403 insufficient_scope with the union of scopes", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "drive", user: "alice" });
    provider.script([[reply.toolCall("drive__list_files", {}, "c0")], "Ok"]);
    await settled(thread(scope, "mcp-drive", "alice", "warm"), "warm");
    provider.script([[reply.toolCall("drive__delete_file", { name: "a.txt" }, "c1")], "Gone"]);
    const alice = thread(scope, "mcp-drive", "alice", "t1");
    const parked = await settled(alice, "delete a.txt");
    const request = requested(parked);
    await consent(drive, request.authUrl);
    expect(drive.oauth?.authorizations.at(-1)?.scope).toBe("drive:read drive:write");
    const resumed = await rest(alice, parked.at(-1)!.seq);
    expect(result(resumed, "c1")).toMatchObject({ isError: false, content: [{ type: "text", text: "Deleted a.txt" }] });
    expect(lastMessage(resumed)).toBe("Gone");
  });
});

describe("agent-level grants and client registration", () => {
  it("registers dynamically, keeps the issued secret in the SecretsProvider, and disconnects on request", async () => {
    const scope = await fresh();
    await grant(scope, { serverId: "crm", agent: "mcp-crm" });
    expect(crm.oauth?.registrations[0]).toMatchObject({
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      application_type: "web",
      client_name: "karmi test",
    });
    expect(crm.oauth?.tokenRequests[0]).toMatchObject({ clientId: "dcr-1", clientSecret: "secret-1" });
    expect((await secrets.list(scope.id)).map((c) => c.name)).toEqual([expect.stringMatching(/^__mcp-client-/)]);
    expect(await scope.agents.connections.list("mcp-crm")).toEqual([
      { name: "mcp:crm", updatedAt: expect.any(Number) },
    ]);

    provider.script([[reply.toolCall("crm__contacts", {}, "c1")], "Ok"]);
    const events = await settled(thread(scope, "mcp-crm", "anyone", "t1"), "contacts");
    expect(result(events, "c1")).toMatchObject({ isError: false, content: [{ type: "text", text: "alice, bob" }] });

    await scope.mcp.disconnect({ serverId: "crm", agent: "mcp-crm" });
    expect(await scope.agents.connections.list("mcp-crm")).toEqual([]);
    provider.script([[reply.toolCall("crm__contacts", {}, "c2")], "Ok"]);
    const parked = await settled(thread(scope, "mcp-crm", "anyone", "t2"), "contacts");
    expect(requested(parked)).toMatchObject({ kind: "connect", serverId: "crm", level: "agent" });
    // The second registration reuses the stored client rather than registering again.
    expect(crm.oauth?.registrations).toHaveLength(1);
  });

  it("names the pre-registration checklist for a server that takes neither CIMD nor DCR, and works once a client is set", async () => {
    const scope = await fresh();
    await expect(scope.mcp.authorize({ serverId: "locked", agent: "mcp-locked" })).rejects.toMatchObject({
      code: "mcp.oauth.preRegistrationRequired",
      message: expect.stringContaining(CALLBACK),
    });
    await secrets.put({ scope: scope.id, ref: "scope:locked-secret" }, sensitive("s3cret"));
    await scope.config.set({
      ...base,
      mcp: {
        servers: {
          ...base.mcp?.servers,
          locked: {
            url: locked.url,
            auth: { type: "oauth", level: "agent", client: { id: "my-app", secret: "scope:locked-secret" } },
          },
        },
      },
    });
    await grant(scope, { serverId: "locked", agent: "mcp-locked" });
    expect(locked.oauth?.authorizations[0]?.clientId).toBe("my-app");
    expect(locked.oauth?.tokenRequests[0]).toMatchObject({ clientId: "my-app", clientSecret: "s3cret" });
    provider.script([[reply.toolCall("locked__ping", {}, "c1")], "Ok"]);
    const events = await settled(thread(scope, "mcp-locked", "u", "t1"), "ping");
    expect(result(events, "c1")).toMatchObject({ isError: false, content: [{ type: "text", text: "pong" }] });
  });

  it("rejects authorize and disconnect for a server that is not OAuth, or without the holder it needs", async () => {
    const scope = await fresh({
      mcp: { servers: { ...base.mcp?.servers, plain: { url: "https://plain.mcp.test/mcp" } } },
    });
    await expect(scope.mcp.authorize({ serverId: "plain", agent: "a" })).rejects.toMatchObject({
      code: "mcp.oauth.notOAuth",
    });
    await expect(scope.mcp.authorize({ serverId: "drive" })).rejects.toThrowError(KarmiError);
    await expect(scope.mcp.disconnect({ serverId: "nope" })).rejects.toMatchObject({ code: "mcp.server.unknown" });
  });
});

describe("callback route", () => {
  it("rejects a malformed, unknown or expired state, and redirects to returnTo when asked", async () => {
    const scope = await fresh();
    expect((await karmi.oauth.handle(new Request(`${CALLBACK}?code=x`)))?.status).toBe(400);
    expect((await karmi.oauth.handle(new Request(`${CALLBACK}?code=x&state=${scope.id}.nope`)))?.status).toBe(400);
    const { authUrl } = await scope.mcp.authorize({ serverId: "drive", user: "alice" });
    await clock.advance(11 * 60 * 1000);
    expect((await consent(drive, authUrl))?.status).toBe(400);
    expect(await scope.users.connections.list("alice")).toEqual([]);

    const again = await scope.mcp.authorize({
      serverId: "drive",
      user: "alice",
      returnTo: "https://app.test/settings",
    });
    const response = await consent(drive, again.authUrl);
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("https://app.test/settings?mcp=drive&connected=true");
  });
});

describe("provider execution", () => {
  it("hands an execution: provider server to the model call with its token instead of offering its tools", async () => {
    const scope = await fresh({
      mcp: {
        servers: {
          ...base.mcp?.servers,
          crm: { url: crm.url, auth: { type: "oauth", level: "agent" }, execution: "provider", allow: ["contacts"] },
        },
      },
    });
    await grant(scope, { serverId: "crm", agent: "mcp-crm" });
    provider.script(["Ok"]);
    await settled(thread(scope, "mcp-crm", "u", "t1"), "hi");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["weather", "read_output", "tool_search"]);
    expect(provider.requests[0]?.mcpServers).toMatchObject([{ name: "crm", url: crm.url, allow: ["contacts"] }]);
    expect(calls(crm, "tools/list")).toHaveLength(0);
  });
});

describe("user-level Catalogue Connections", () => {
  it("resolves a User's own Connection before the Agent's", async () => {
    const scope = await fresh();
    await scope.agents.connections.set("guarded", "crm", { token: "agent" });
    await scope.users.connections.set("guest-1", "crm", { token: "user" });
    expect(await scope.users.connections.list("guest-1")).toEqual([{ name: "crm", updatedAt: expect.any(Number) }]);
    provider.script([[reply.toolCall("whoami", {}, "c1")], "Ok"]);
    const events = await settled(thread(scope, "guarded", "guest-1", "t1"), "who");
    const seen = JSON.parse((result(events, "c1") as { content: { text: string }[] }).content[0]!.text);
    expect(seen.connection).toEqual({ name: "crm", type: "crm", level: "user", value: { token: "user" } });
    await scope.users.connections.delete("guest-1", "crm");
    provider.script([[reply.toolCall("whoami", {}, "c2")], "Ok"]);
    const again = await settled(thread(scope, "guarded", "guest-1", "t2"), "who");
    const fallback = JSON.parse((result(again, "c2") as { content: { text: string }[] }).content[0]!.text);
    expect(fallback.connection).toMatchObject({ level: "agent", value: { token: "agent" } });
  });
});
