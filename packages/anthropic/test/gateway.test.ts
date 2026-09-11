import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@karmi/core";
import { anthropic } from "../src/index.js";
import text from "./fixtures/text.sse?raw";
import { collect, request, serve } from "./helpers.js";

const attribution = { scope: "acme", agent: "concierge", thread: "t1", turn: 3 };
const gateway = (extra: Partial<ProviderConfig["gateway"] & object> = {}): ProviderConfig => ({
  adapter: "anthropic",
  gateway: {
    kind: "cloudflare",
    accountId: "acct",
    gatewayId: "gw",
    credential: "deployment:aig",
    byok: true,
    ...extra,
  },
});

describe("AI Gateway", () => {
  it("routes to the gateway with the gateway token, BYOK sends no provider auth header, and captures cf-aig-log-id", async () => {
    const provider = anthropic({ credentials: { "deployment:aig": "cf-token" } });
    const server = serve({ sse: text, headers: { "cf-aig-log-id": "log-123" } });
    const events = await collect(provider, request({ config: gateway() }), { fetch: server.fetch, attribution });
    const call = server.calls[0]!;
    expect(call.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages?beta=true");
    expect(call.headers["cf-aig-authorization"]).toBe("Bearer cf-token");
    expect(call.headers).not.toHaveProperty("x-api-key");
    expect(call.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(call.headers["cf-aig-metadata"]!)).toEqual({
      scope: "acme",
      agent: "concierge",
      thread: "t1",
      turn: 3,
    });
    expect(events.at(-1)).toMatchObject({
      type: "message.end",
      usage: { gateway: { provider: "cloudflare", id: "log-123" } },
    });
  });

  it("forwards the provider key through the gateway when the profile holds its own credential", async () => {
    const provider = anthropic({
      credentials: (ref) => ({ "scope:anthropic": "sk-scope", "deployment:aig": "cf-token" })[ref],
    });
    const server = serve({ sse: text });
    await collect(provider, request({ config: { ...gateway({ byok: false }), credential: "scope:anthropic" } }), {
      fetch: server.fetch,
    });
    expect(server.calls[0]!.headers["x-api-key"]).toBe("sk-scope");
    expect(server.calls[0]!.headers["cf-aig-authorization"]).toBe("Bearer cf-token");
  });

  it("stamps one Platform metadata slot beside karmi's four and the cache, retry and timeout headers", async () => {
    const provider = anthropic({ credentials: { "deployment:aig": "cf-token" } });
    const server = serve({ sse: text });
    await collect(
      provider,
      request({
        config: gateway({
          metadata: { tenant: "t-9", ignored: "x" },
          cache: { ttl: 60, skip: true, key: "k" },
          retry: { maxAttempts: 2, delayMs: 100, backoff: "linear" },
          timeoutMs: 5000,
        }),
      }),
      { fetch: server.fetch, attribution },
    );
    const { headers } = server.calls[0]!;
    expect(JSON.parse(headers["cf-aig-metadata"]!)).toEqual({ tenant: "t-9", ...attribution });
    expect(headers).toMatchObject({
      "cf-aig-cache-ttl": "60",
      "cf-aig-skip-cache": "true",
      "cf-aig-cache-key": "k",
      "cf-aig-max-attempts": "2",
      "cf-aig-retry-delay": "100",
      "cf-aig-backoff": "linear",
      "cf-aig-request-timeout": "5000",
    });
  });

  it("uses a profile baseUrl and passes profile headers through when no gateway is set", async () => {
    const provider = anthropic({ apiKey: "sk-test" });
    const server = serve({ sse: text });
    await collect(
      provider,
      request({
        config: { adapter: "anthropic", baseUrl: "https://proxy.example.com/anthropic", headers: { "x-trace": "abc" } },
      }),
      { fetch: server.fetch },
    );
    expect(server.calls[0]!.url).toBe("https://proxy.example.com/anthropic/v1/messages?beta=true");
    expect(server.calls[0]!.headers["x-trace"]).toBe("abc");
  });

  it("fails with an auth error, before any request, when a credential does not resolve", async () => {
    const server = serve({ sse: text });
    expect(
      await collect(anthropic({}), request({ config: { adapter: "anthropic", credential: "scope:missing" } }), server),
    ).toEqual([
      {
        type: "error",
        error: { code: "auth", message: 'Credential "scope:missing" did not resolve.', retryable: false },
      },
    ]);
    expect(await collect(anthropic({}), request(), server)).toEqual([
      {
        type: "error",
        error: {
          code: "auth",
          message: "The Provider profile names no credential and the adapter has no apiKey.",
          retryable: false,
        },
      },
    ]);
    expect(await collect(anthropic({}), request({ config: gateway() }), server)).toEqual([
      {
        type: "error",
        error: { code: "auth", message: 'Gateway credential "deployment:aig" did not resolve.', retryable: false },
      },
    ]);
    expect(server.calls).toEqual([]);
  });
});
