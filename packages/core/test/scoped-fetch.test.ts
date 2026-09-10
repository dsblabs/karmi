import { describe, expect, it } from "vitest";
import { isBlockedUrl, scopedFetch } from "../src/index.js";

type Seen = { url: string; init: RequestInit | undefined };

/** A transport that records what reached it and answers 200 with the URL it saw. */
function probe(): { calls: Seen[]; fetch: typeof fetch } {
  const calls: Seen[] = [];
  const underlying = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return new Response(url, { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: underlying };
}

describe("isBlockedUrl", () => {
  it.each(["not a url", "http://0.0.0.0/", "http://[::]/", "http://metadata.google.internal/", "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://0.1.2.3/", "http://[fc00::1]/", "http://[fd12::1]/", "http://[fe80::1]/", "http://[febf::1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:a00:1]/"])("blocks %s", (url) => {
    expect(isBlockedUrl(url)).toBe(true);
  });

  it.each(["https://api.anthropic.com/v1/messages", "http://127.0.0.1:8787/mcp", "http://[::1]/", "http://172.15.0.1/", "http://172.32.0.1/", "http://[fe7f::1]/", "http://[fec0::1]/", "https://8.8.8.8/"])("allows %s", (url) => {
    expect(isBlockedUrl(url)).toBe(false);
  });
});

describe("scopedFetch", () => {
  it("refuses blocked addresses with a synthetic 403 and never reaches the transport", async () => {
    const { calls, fetch: underlying } = probe();
    const response = await scopedFetch({ fetch: underlying })("http://169.254.169.254/latest/meta-data");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "egress.blocked", message: expect.stringContaining("169.254.169.254") } });
    expect(calls).toEqual([]);
  });

  it("refuses hosts outside the allow-list, matching exact names and `*.` globs", async () => {
    const { calls, fetch: underlying } = probe();
    const fetch = scopedFetch({ hosts: ["api.anthropic.com", "*.example.com"], fetch: underlying });
    expect((await fetch("https://api.anthropic.com/v1/messages")).status).toBe(200);
    expect((await fetch("https://mcp.example.com/mcp")).status).toBe(200);
    expect((await fetch("https://deep.mcp.example.com/mcp")).status).toBe(200);
    const denied = await fetch("https://example.com/");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: "egress.denied", message: expect.stringContaining("example.com") } });
    expect((await fetch("https://evil.com/")).status).toBe(403);
    expect(calls.map((call) => call.url)).toEqual(["https://api.anthropic.com/v1/messages", "https://mcp.example.com/mcp", "https://deep.mcp.example.com/mcp"]);
  });

  it("lets any public host through when no allow-list is set", async () => {
    const { calls, fetch: underlying } = probe();
    expect((await scopedFetch({ fetch: underlying })("https://anything.example.org/")).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("forces manual redirects and keeps the caller's other init options", async () => {
    const { calls, fetch: underlying } = probe();
    await scopedFetch({ fetch: underlying })("https://api.anthropic.com/v1/messages", { method: "POST", redirect: "follow", headers: { "x-test": "1" } });
    expect(calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual", headers: { "x-test": "1" } });
  });

  it("checks a Request object's URL like a string one", async () => {
    const { calls, fetch: underlying } = probe();
    const fetch = scopedFetch({ hosts: ["api.anthropic.com"], fetch: underlying });
    expect((await fetch(new Request("https://api.anthropic.com/v1/messages"))).status).toBe(200);
    expect((await fetch(new Request("https://other.example/"))).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("logs a denial when given a Logger", async () => {
    const warnings: unknown[] = [];
    const logger = { debug() {}, info() {}, warn: (message: string, fields?: unknown) => void warnings.push([message, fields]), error() {} };
    await scopedFetch({ hosts: ["api.anthropic.com"], fetch: probe().fetch, logger })("https://other.example/x");
    expect(warnings).toEqual([["egress denied", { code: "egress.denied", host: "other.example" }]]);
  });
});
