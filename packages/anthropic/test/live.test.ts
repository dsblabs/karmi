import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { scopedFetch } from "@karmi/core";
import { anthropic } from "../src/index";
import { collect, request } from "./helpers";

// Opt in with ANTHROPIC_API_KEY=... pnpm test; one small real call through scopedFetch.
describe.skipIf(!env.ANTHROPIC_API_KEY)("live Anthropic", () => {
  it("streams one short reply and reports usage", async () => {
    const provider = anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const events = await collect(
      provider,
      request({
        model: "claude-haiku-4-5",
        params: { maxOutputTokens: 16, reasoning: "off" },
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }],
      }),
      { fetch: scopedFetch({ hosts: ["api.anthropic.com"] }) },
    );
    expect(events[0]).toMatchObject({ type: "message.start", model: expect.stringContaining("claude") });
    expect(events.some((event) => event.type === "part" && event.block.type === "text")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "message.end",
      usage: { input: expect.any(Number), output: expect.any(Number) },
    });
  }, 30_000);
});
