import { describe, expect, it } from "vitest";
import { anthropic } from "../src/index.js";
import text from "./fixtures/text.sse?raw";
import { collect, request, serve } from "./helpers.js";

const provider = anthropic({ apiKey: "sk-test" });
const failure = (status: number, type: string, message: string) => ({ status, json: { type: "error", error: { type, message } } });

describe("error classification", () => {
  it.each([
    [401, "authentication_error", "auth", false],
    [403, "permission_error", "auth", false],
    [400, "invalid_request_error", "invalid_request", false],
    [404, "not_found_error", "invalid_request", false],
    [429, "rate_limit_error", "rate_limit", true],
    [500, "api_error", "unavailable", true],
    [529, "overloaded_error", "unavailable", true],
  ])("maps HTTP %s (%s) to %s, retryable %s", async (status, type, code, retryable) => {
    const server = serve(failure(status, type, "nope"));
    const events = await collect(provider, request(), server);
    expect(events).toEqual([{ type: "error", error: { code, message: "nope", retryable, status, raw: { type: "error", error: { type, message: "nope" } } } }]);
  });

  it("recognises a context-window overflow and a billing problem in a 400", async () => {
    expect(await collect(provider, request(), serve(failure(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum")))).toMatchObject([{ error: { code: "context_window_exceeded", retryable: false } }]);
    expect(await collect(provider, request(), serve(failure(400, "billing_error", "Your credit balance is too low")))).toMatchObject([{ error: { code: "quota", retryable: false } }]);
  });

  it("treats an egress denial from scopedFetch as an invalid request, not a retry", async () => {
    const events = await collect(provider, request(), serve({ status: 403, json: { error: { code: "egress.denied", message: "Egress to api.anthropic.com is outside this Scope's allowed hosts." } } }));
    expect(events).toEqual([{ type: "error", error: { code: "invalid_request", message: "Egress to api.anthropic.com is outside this Scope's allowed hosts.", retryable: false, status: 403, raw: { error: { code: "egress.denied", message: "Egress to api.anthropic.com is outside this Scope's allowed hosts." } } } }]);
  });

  it("classifies a transport failure as a retryable network error", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const events = await collect(provider, request(), { fetch: broken });
    expect(events).toMatchObject([{ type: "error", error: { code: "network", retryable: true } }]);
  });
});

describe("retry", () => {
  it("retries a retryable failure before the first byte and then streams", async () => {
    const server = serve(failure(529, "overloaded_error", "busy"), failure(500, "api_error", "hiccup"), { sse: text });
    const events = await collect(provider, request(), server);
    expect(server.calls).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "message.end", stopReason: "end_turn" });
  }, 10_000);

  it("gives up after three attempts", async () => {
    const server = serve(failure(529, "overloaded_error", "busy"));
    const events = await collect(provider, request(), server);
    expect(server.calls).toHaveLength(3);
    expect(events).toMatchObject([{ type: "error", error: { code: "unavailable", retryable: true } }]);
  }, 10_000);

  it("does not retry a non-retryable failure", async () => {
    const server = serve(failure(401, "authentication_error", "bad"), { sse: text });
    await collect(provider, request(), server);
    expect(server.calls).toHaveLength(1);
  });

  it("leaves retrying to the gateway when the profile configures gateway retries", async () => {
    const server = serve(failure(529, "overloaded_error", "busy"));
    await collect(anthropic({ credentials: { "deployment:aig": "t" } }), request({ config: { adapter: "anthropic", gateway: { kind: "cloudflare", accountId: "a", gatewayId: "g", credential: "deployment:aig", byok: true, retry: { maxAttempts: 3 } } } }), server);
    expect(server.calls).toHaveLength(1);
  });
});
