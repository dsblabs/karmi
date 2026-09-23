import type { ThreadEvent } from "@karmi/core";
import { reply } from "@karmi/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  deliverySchema,
  EXAMPLE_CHILD_RECORD,
  OBSERVABILITY,
  SAMPLE_LOG_FIELDS,
  STARTING_INSPECTION,
} from "../src/observability";
import { orderSchema, STARTING_ORDER } from "../src/refund";
import { api as request, events } from "./client";
import { playgroundReplies } from "./script";
import { clock, karmi, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${OBSERVABILITY}`;

const costSchema = z.object({
  amount: z.number(),
  currency: z.literal("USD"),
  source: z.enum(["openrouter", "vercel-gateway"]),
  basis: z.enum(["billed", "list", "estimate"]),
});

const usageSchema = z.looseObject({
  type: z.literal("usage.recorded"),
  kind: z.string(),
  scope: z.string(),
  agent: z.string(),
  user: z.optional(z.string()),
  threadId: z.string(),
  seq: z.number(),
  turn: z.number(),
  parent: z.optional(z.object({ threadKey: z.string(), callId: z.string() })),
  cost: z.optional(costSchema),
});

const stateSchema = z.looseObject({
  threadKey: z.string(),
  usage: z.array(usageSchema),
  handler: z.object({
    failNext: z.boolean(),
    deliveries: z.array(deliverySchema),
  }),
  logs: z.array(
    z.object({
      level: z.string(),
      message: z.string(),
      fields: z.record(z.string(), z.unknown()),
    }),
  ),
  redaction: z.optional(
    z.object({ before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) }),
  ),
  exampleChild: usageSchema,
});

const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());

async function until(key: string, type: ThreadEvent["type"]): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).some((event) => event.type === type), { timeout: 10_000 })
    .toBe(true);
  return log;
}

/** Sends one prompt and waits for the Turn and for the Queue to flush. */
async function run(text: string): Promise<string> {
  const { threadKey } = await state();
  const sent = await api("POST", `/threads/${threadKey}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
  await until(threadKey, "turn.completed");
  await clock.advance(0);
  return threadKey;
}

async function accepted(count: number) {
  await expect
    .poll(async () => (await state()).handler.deliveries.filter((item) => item.status === "accepted").length, {
      timeout: 10_000,
    })
    .toBe(count);
  return state();
}

beforeEach(async () => {
  await api("POST", `${PATH}/reset`);
});

describe("the Usage and logging scenario", () => {
  it("shows Usage records with Scope, Agent, User, Thread and seq, and omits cost when the Provider reports none", async () => {
    provider.script(["Ticket T-9 is open."]);
    await run("What is the spend?");
    const now = await accepted(1);
    const [record] = now.usage;
    expect(record).toMatchObject({
      type: "usage.recorded",
      kind: "model",
      scope: "sample-a",
      agent: OBSERVABILITY,
      user: "operator",
      threadId: expect.stringContaining(OBSERVABILITY),
    });
    expect(record?.seq).toBeGreaterThan(0);
    expect(record).not.toHaveProperty("cost");
    expect(record).not.toHaveProperty("parent");
    expect(JSON.stringify(record)).not.toMatch(/"cost"\s*:/);
  });

  it("shows a reported cost unchanged and does not invent a price", async () => {
    const cost = { amount: 0.0042, currency: "USD" as const, source: "openrouter" as const, basis: "billed" as const };
    provider.script([[reply.text("Priced."), reply.usage({ input: 8, output: 6, cost })]]);
    await run("What did this call cost?");
    const now = await accepted(1);
    expect(now.usage[0]?.cost).toEqual(cost);
  });

  it("uses the browser script to report a cost on the Spend prompt", async () => {
    provider.script(playgroundReplies);
    await run("What is the spend of this Thread so far?");
    const now = await accepted(1);
    expect(now.usage[0]?.cost).toEqual({
      amount: 0.0042,
      currency: "USD",
      source: "openrouter",
      basis: "billed",
    });
  });

  it("delivers records to the sample UsageHandler and retries a failed batch", async () => {
    expect((await api("POST", `${PATH}/fail`)).status).toBe(200);
    expect((await state()).handler.failNext).toBe(true);
    provider.script(["Ticket T-9 is open."]);
    await run("What is the spend?");
    await expect
      .poll(async () => (await state()).handler.deliveries.some((item) => item.status === "failed"), {
        timeout: 10_000,
      })
      .toBe(true);
    const after = await accepted(1);
    expect(new Set(after.handler.deliveries.map((item) => item.key)).size).toBe(1);
    expect(after.handler.deliveries.some((item) => item.status === "failed")).toBe(true);
    expect(after.handler.deliveries.some((item) => item.status === "accepted" && !item.duplicate)).toBe(true);
  });

  it("marks a second delivery of the same record as a duplicate", async () => {
    provider.script(["Ticket T-9 is open."]);
    await run("What is the spend?");
    await accepted(1);
    expect((await api("POST", `${PATH}/replay`)).status).toBe(200);
    const now = await state();
    expect(now.handler.deliveries.filter((item) => item.duplicate)).toHaveLength(1);
    expect(now.handler.deliveries.filter((item) => item.status === "accepted")).toHaveLength(2);
  });

  it("stores redacted logs and redacts a sample object at the route", async () => {
    provider.script([[reply.toolCall("lookup_ticket", { ticketId: "T-9" }, "t1")], "Ticket T-9 is open."]);
    await run("Look up ticket T-9.");
    await expect.poll(async () => (await state()).logs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const line = (await state()).logs.find((entry) => entry.message.includes("ticket"));
    expect(line?.fields).toMatchObject({
      scope: "sample-a",
      agent: OBSERVABILITY,
      user: "operator",
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      ticketId: "T-9",
    });
    expect(JSON.stringify(line)).not.toContain("sk-live-example");
    expect(JSON.stringify(line)).not.toContain("secret-token");

    const redacted = stateSchema.parse(await (await api("POST", `${PATH}/redact`)).json());
    expect(redacted.redaction?.before).toEqual(SAMPLE_LOG_FIELDS);
    expect(redacted.redaction?.after).toMatchObject({
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      ticketId: "T-9",
    });
  });

  it("shows the parent shape of a Delegation child without installing that scenario", async () => {
    const now = await state();
    expect(now.exampleChild).toEqual(EXAMPLE_CHILD_RECORD);
    expect(now.exampleChild.parent).toEqual(EXAMPLE_CHILD_RECORD.parent);
    expect(now.handler).toEqual(STARTING_INSPECTION);
  });

  it("clears this scenario on reset and leaves other usage and credentials", async () => {
    provider.script(["Ticket T-9 is open."]);
    await run("What is the spend?");
    await accepted(1);
    const credentials = karmi.scope("sample-a").credentials;
    await credentials.put("kept", "secret-value");
    await api("POST", "/api/scenarios/refund/reset");
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    expect(orderSchema.parse((refund as { order: unknown }).order)).toEqual(STARTING_ORDER);
    expect((await state()).usage.length).toBeGreaterThan(0);

    const before = await state();
    const reset = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(reset.threadKey).not.toBe(before.threadKey);
    expect(reset.usage).toEqual([]);
    expect(reset.logs).toEqual([]);
    expect(reset.handler).toEqual(STARTING_INSPECTION);
    expect(await credentials.describe("kept")).toMatchObject({ version: 1 });
  });
});
