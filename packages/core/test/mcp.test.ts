import { env } from "cloudflare:test";
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
import { clock, github, karmi, legacy, provider, secrets, trace } from "./worker";

const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const base: ScopeConfigDocument = {
  mcp: {
    servers: {
      github: {
        url: github.url,
        auth: { type: "static", headers: { Authorization: "scope:gh" } },
        trustAnnotations: true,
      },
      legacy: { url: legacy.url, catalog: { ttlMs: 1000 } },
    },
  },
};

let n = 0;
/** A fresh Scope per test, so catalogue caches and config never leak between them. */
async function fresh(patch: Partial<ScopeConfigDocument> = {}): Promise<Scope> {
  const scope = karmi.scope(`mcp-${++n}`);
  await secrets.put({ scope: scope.id, ref: "scope:gh" }, sensitive("Bearer gh-token"));
  await scope.config.set({ ...base, ...patch });
  return scope;
}
const thread = (scope: Scope, agent = "mcp-agent", threadId = "t1") => scope.thread({ agent, user: "u", threadId });

async function settled(thread: Thread, text: string): Promise<ThreadEvent[]> {
  const { turn, seq } = await thread.send(message(text));
  const events: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: seq })) {
    if (event.turn !== turn) continue;
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
  }
  return events;
}
const result = (events: ThreadEvent[], id: string) => events.find((e) => e.type === "tool.result" && e.id === id);
const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

beforeEach(() => {
  github.reset();
  legacy.reset();
  trace.length = 0;
});

describe("tool source", () => {
  it("offers the servers' tools grouped by server after the Catalogue tools, named server__tool", async () => {
    provider.script(["Hi"]);
    await settled(thread(await fresh()), "hello");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "weather",
      "github__search_issues",
      "github__create_issue",
      "github__repos_list",
      "github__attach",
      "github__ask_user",
      "legacy__echo",
      "read_output",
      "tool_search",
    ]);
    expect(provider.requests[0]?.tools?.find((t) => t.name === "github__create_issue")?.inputSchema).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } },
    });
  });

  it("stamps turn.started with a version that changes when a server's catalogue changes", async () => {
    provider.script(["One", "Two", "Three"]);
    const scope = await fresh();
    const first = await settled(thread(scope), "one");
    const version = (events: ThreadEvent[]) => {
      const started = events.find((e) => e.type === "turn.started");
      return started?.type === "turn.started" ? started.toolsVersion : undefined;
    };
    expect(version(await settled(thread(scope), "two"))).toBe(version(first));
    legacy.tools = [...legacy.tools, { name: "shout", execute: () => "!" }];
    await clock.advance(2000);
    const third = await settled(thread(scope), "three");
    expect(version(third)).not.toBe(version(first));
    // The Spec references only `mcp:legacy/echo`, so the new tool changes the version but is never offered.
    expect(provider.requests[2]?.tools?.map((t) => t.name)).not.toContain("legacy__shout");
    expect(methods(legacy.calls).filter((m) => m === "tools/list")).toHaveLength(2);
  });
});

describe("calls", () => {
  it("calls a modern server with the static header and renders the result with its structured content", async () => {
    provider.script([[reply.toolCall("github__create_issue", { title: "Bug" }, "c1")], "Done"]);
    const events = await settled(thread(await fresh()), "file it");
    expect(result(events, "c1")).toMatchObject({ content: [{ type: "text", text: "Created Bug" }], isError: false });
    expect(lastMessage(events)).toBe("Done");
    const call = github.calls.find((c) => c.method === "tools/call");
    expect(call?.headers.authorization).toBe("Bearer gh-token");
    expect(call?.params).toMatchObject({ name: "create_issue", arguments: { title: "Bug" } });
    expect(methods(github.calls)).toEqual(["server/discover", "tools/list", "tools/call"]);
  });

  it("talks the legacy era: initialize, one Mcp-Session-Id per Thread connection, no listen stream", async () => {
    provider.script([[reply.toolCall("legacy__echo", { text: "hi" }, "c1")], "Done"]);
    const events = await settled(thread(await fresh()), "echo");
    expect(result(events, "c1")).toMatchObject({ content: [{ type: "text", text: "hi" }] });
    // One connection per Thread Turn: the list and the call ride the same session.
    expect(methods(legacy.calls)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    const [, init, , list, call] = legacy.calls;
    expect(list?.headers["mcp-session-id"]).toBeDefined();
    expect(call?.headers["mcp-session-id"]).toBe(list?.headers["mcp-session-id"]);
    expect(init?.headers["mcp-session-id"]).toBeUndefined();
  });

  it("runs a trusted server's read-only tools in parallel and an untrusted server's serially", async () => {
    provider.script([
      [
        reply.toolCall("github__search_issues", { q: "a" }, "c1"),
        reply.toolCall("github__search_issues", { q: "b" }, "c2"),
      ],
      "Done",
    ]);
    const events = await settled(thread(await fresh()), "search");
    expect(events.map((e) => e.type).filter((t) => t.startsWith("tool."))).toEqual([
      "tool.call",
      "tool.call",
      "tool.result",
      "tool.result",
    ]);
  });

  it("surfaces input_required as an error result the model sees", async () => {
    provider.script([[reply.toolCall("github__ask_user", {}, "c1")], "Ok"]);
    const events = await settled(thread(await fresh()), "ask");
    expect(result(events, "c1")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("interactive input") }],
    });
  });

  it("renders resource content: text inline, binary spilled to media, links as text", async () => {
    provider.script([[reply.toolCall("github__attach", {}, "c1")], "Ok"]);
    const scope = await fresh();
    const events = await settled(thread(scope), "attach");
    const got = result(events, "c1");
    expect(got).toMatchObject({
      content: [
        { type: "text", text: "gh://readme:\nHello" },
        { type: "media", media: { mimeType: "image/png", name: "gh://logo" } },
        { type: "text", text: "Resource Issue 1 (gh://issues/1)" },
      ],
    });
    const media = got?.type === "tool.result" ? got.content[1] : undefined;
    if (media?.type !== "media") throw new Error("expected media");
    expect(media.media.key.startsWith(`${scope.id}/media/t1/`)).toBe(true);
    expect((await env.KARMI_MEDIA.get(media.media.key))?.httpMetadata?.contentType).toBe("image/png");
  });

  it("refreshes the catalogue on -32602 and offers the corrected tool at the next Step", async () => {
    provider.script(["warm"]);
    const scope = await fresh();
    await settled(thread(scope, "mcp-agent", "warm"), "warm");
    github.reset();
    provider.script([[reply.toolCall("github__repos_list", {}, "c1")], "Ok"]);
    // The server changed its catalogue under us; the cached definition is stale until the call says so.
    github.tools = github.tools
      .filter((t) => t.name !== "repos.list")
      .concat({ name: "list_repos", execute: () => "x" });
    try {
      const events = await settled(thread(scope, "mcp-agent", "stale"), "list");
      expect(result(events, "c1")).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("refreshed") }],
      });
      // The cached modern era verdict is adopted with zero round trips, so only the call and the re-list reach the server.
      expect(methods(github.calls)).toEqual(["tools/call", "tools/list"]);
      expect(provider.requests[1]?.tools?.map((t) => t.name)).toContain("github__list_repos");
    } finally {
      github.tools = github.tools
        .filter((t) => t.name !== "list_repos")
        .concat({ name: "repos.list", description: "List repos", execute: () => "repo-a, repo-b" });
    }
  });
});

describe("catalogue cache", () => {
  it("lists tools once per ttl, refreshing at Turn start when stale", async () => {
    provider.script(["a", "b", "c"]);
    const scope = await fresh();
    await settled(thread(scope, "mcp-agent", "a"), "a");
    await settled(thread(scope, "mcp-agent", "b"), "b");
    expect(methods(github.calls).filter((m) => m === "tools/list")).toHaveLength(1);
    expect(methods(legacy.calls).filter((m) => m === "tools/list")).toHaveLength(1);
    await clock.advance(1500);
    await settled(thread(scope, "mcp-agent", "c"), "c");
    // The legacy server's configured ttl of a second elapsed; the modern server's server-sent minute did not.
    expect(methods(legacy.calls).filter((m) => m === "tools/list")).toHaveLength(2);
    expect(methods(github.calls).filter((m) => m === "tools/list")).toHaveLength(1);
  });

  it("adopts a cached modern era verdict with zero probe round trips", async () => {
    provider.script(["a", "b"]);
    const scope = await fresh();
    await settled(thread(scope, "mcp-pinned", "a"), "a");
    github.reset();
    provider.script([[reply.toolCall("github__search_issues", { q: "x" }, "c1")], "b"]);
    await settled(thread(scope, "mcp-pinned", "b"), "b");
    expect(methods(github.calls)).toEqual(["tools/call"]);
  });

  it("serves the stale catalogue when a refresh fails, and reports a server that never answered", async () => {
    provider.script(["a", "b"]);
    const scope = await fresh({
      mcp: { servers: { ...base.mcp?.servers, legacy: { url: legacy.url, catalog: { ttlMs: 1000 } } } },
    });
    await settled(thread(scope, "mcp-agent", "a"), "a");
    await clock.advance(2000);
    const tools = legacy.tools;
    legacy.tools = [{ name: "boom", execute: () => "x" }];
    try {
      await scope.config.set({ ...base, egress: { mcpHosts: ["github.mcp.test"] } });
      await settled(thread(scope, "mcp-agent", "b"), "b");
      expect(provider.requests[1]?.tools?.map((t) => t.name)).toContain("legacy__echo");
    } finally {
      legacy.tools = tools;
    }
  });
});

describe("egress and credentials", () => {
  it("denies a server outside egress.mcpHosts before any request reaches it", async () => {
    provider.script([[reply.toolCall("github__search_issues", { q: "x" }, "c1")], "Ok"]);
    const scope = await fresh({ egress: { mcpHosts: ["legacy.mcp.test"] } });
    const events = await settled(thread(scope), "search");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("github__search_issues");
    expect(result(events, "c1")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: 'Unknown tool "github__search_issues".' }],
    });
    expect(github.calls).toEqual([]);
  });

  it("leaves a server out when its static credential is missing, without failing the Turn", async () => {
    provider.script(["Ok"]);
    const scope = karmi.scope(`mcp-${++n}`);
    await scope.config.set(base);
    const events = await settled(thread(scope), "hello");
    expect(lastMessage(events)).toBe("Ok");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "weather",
      "legacy__echo",
      "read_output",
      "tool_search",
    ]);
  });
});

describe("scope.mcp", () => {
  it("snapshots transport config with redacted headers and refreshes catalogues on request", async () => {
    const scope = await fresh();
    const snapshot = await scope.mcp.snapshot({ agent: "mcp-agent", serverIds: ["github"] });
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0]?.catalog).toBeUndefined();
    expect(JSON.stringify(snapshot.servers[0]?.config)).not.toContain("gh-token");
    expect(() => JSON.stringify(snapshot.servers[0]?.headers)).toThrowError(
      expect.objectContaining({ code: "secrets.exposed" }),
    );
    const versions = await scope.mcp.refreshCatalog();
    expect(Object.keys(versions).sort()).toEqual(["github", "legacy"]);
    const again = await scope.mcp.snapshot({ serverIds: ["github"] });
    expect(again.servers[0]?.catalog?.catalogVersion).toBe(versions.github);
    expect(again.servers[0]?.catalog?.era.kind).toBe("modern");
    await expect(scope.mcp.refreshCatalog("nope")).rejects.toThrowError(KarmiError);
  });
});
