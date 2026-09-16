import { describe, expect, it, vi } from "vitest";
import { dailyBriefing, decodeInboxMessage, handleInbox } from "../src/triggers";
import { karmi, provider, scope } from "./worker";

/** A Queue batch of `bodies`, with `ack` and `retry` spies the test reads back. */
function batch(bodies: unknown[]): MessageBatch<unknown> & { acked: number[]; retried: number[] } {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, index) => ({
    id: `m${index}`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: () => void acked.push(index),
    retry: () => void retried.push(index),
  }));
  return { queue: "inbox", messages, acked, retried, ackAll: vi.fn(), retryAll: vi.fn() } as never;
}

const message = { scope: "test", agent: "concierge", threadId: "inbox-1", text: "A guest wrote in." };

describe("the Queue trigger", () => {
  it("refuses a body that is not an inbox message", () => {
    expect(() => decodeInboxMessage({ scope: "test" })).toThrowError("InboxMessage");
  });

  it("starts a Turn per message and acknowledges it", async () => {
    provider.script(["Noted."]);
    const work = batch([message]);
    await handleInbox(karmi, work);
    expect(work.acked).toEqual([0]);
    await expect
      .poll(async () => (await scope.thread({ agent: "concierge", threadId: "inbox-1" }).status()).state)
      .toBe("idle");
  });

  it("retries a message it could not decode", async () => {
    const work = batch(["not a message"]);
    await handleInbox(karmi, work);
    expect(work.retried).toEqual([0]);
  });
});

describe("the cron trigger", () => {
  it("starts one briefing Turn per Scope", async () => {
    provider.script(["Two arrivals."]);
    await dailyBriefing(karmi, ["test"], "2026-09-16");
    const thread = scope.thread({ agent: "concierge", threadId: "briefing-2026-09-16" });
    await expect.poll(async () => (await thread.status()).state).toBe("idle");
  });
});
