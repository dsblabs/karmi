import { describe, expect, it } from "vitest";
import {
  cacheHints,
  isStale,
  mcpAnnotations,
  mcpHostAllowList,
  nameTools,
  parseMcpReference,
  selectTools,
  type McpTool,
} from "../src/mcp-catalog";

const tool = (name: string, annotations?: McpTool["annotations"]): McpTool => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations && { annotations }),
});

describe("parseMcpReference", () => {
  it("reads a server or a server/tool reference and rejects anything else", () => {
    expect(parseMcpReference("mcp:github")).toEqual({ server: "github" });
    expect(parseMcpReference("mcp:github/create_issue")).toEqual({ server: "github", tool: "create_issue" });
    expect(parseMcpReference("mcp:a/b/c")).toBeUndefined();
    expect(parseMcpReference("mcp:bad name")).toBeUndefined();
    expect(parseMcpReference("weather")).toBeUndefined();
  });
});

describe("nameTools", () => {
  it("prefixes with the server id and sanitises to the model-facing alphabet", () => {
    expect(nameTools("github", [tool("create_issue"), tool("repos.list")]).map((t) => t.name)).toEqual([
      "github__create_issue",
      "github__repos_list",
    ]);
  });

  it("truncates an overlong name with a hash suffix and keeps colliding names apart", () => {
    const long = "x".repeat(80);
    const [overlong] = nameTools("s", [tool(long)]);
    expect(overlong?.name).toHaveLength(64);
    expect(overlong?.name).toMatch(/^s__x+_[0-9a-f]{8}$/);
    const [a, b] = nameTools("s", [tool("a.b"), tool("a_b")]);
    expect(a?.name).toBe("s__a_b");
    expect(b?.name).toMatch(/^s__a_b_[0-9a-f]{8}$/);
  });
});

describe("selectTools", () => {
  const named = nameTools("s", [tool("read"), tool("write"), tool("delete")]);
  it("applies the allow list, then the deny list, then the reference", () => {
    expect(
      selectTools(named, { allow: ["read", "write"], deny: ["write"] }, { server: "s" }).map((t) => t.name),
    ).toEqual(["s__read"]);
    expect(selectTools(named, {}, { server: "s", tool: "delete" }).map((t) => t.name)).toEqual(["s__delete"]);
    expect(selectTools(named, { deny: ["delete"] }, { server: "s", tool: "delete" })).toEqual([]);
  });
});

describe("mcpAnnotations", () => {
  it("honours a trusted server's hints and treats an untrusted one as destructive", () => {
    const hinted = tool("t", { readOnlyHint: true, destructiveHint: false });
    expect(mcpAnnotations(hinted, true)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(mcpAnnotations(hinted, false)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe("freshness and hosts", () => {
  it("is stale once the ttl has elapsed", () => {
    const catalog = {
      tools: [],
      catalogVersion: "v",
      fetchedAt: 1000,
      ttlMs: 500,
      cacheScope: "public" as const,
      era: { kind: "legacy" as const },
    };
    expect(isStale(catalog, 1499)).toBe(false);
    expect(isStale(catalog, 1500)).toBe(true);
  });

  it("reads cache hints only when they are well-formed", () => {
    expect(cacheHints({ ttlMs: 60_000, cacheScope: "public" })).toEqual({ ttlMs: 60_000, cacheScope: "public" });
    expect(cacheHints({ ttlMs: -1, cacheScope: "shared" })).toEqual({});
  });

  it("narrows the registered server hosts by the egress globs", () => {
    const urls = ["https://mcp.github.com/mcp", "https://tools.example.org/"];
    expect(mcpHostAllowList(urls, undefined)).toEqual(["mcp.github.com", "tools.example.org"]);
    expect(mcpHostAllowList(urls, ["*.github.com"])).toEqual(["mcp.github.com"]);
  });
});
