import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { reply } from "../src/testing/index";
import { beforeEach, expect, it } from "vitest";
import { deliveries, karmi, provider, clock, scope, deliveryFailure } from "./worker";

beforeEach(() => {
  deliveries.length = 0;
  deliveryFailure.remaining = 0;
});

it("delivers an offline payment webhook reply through the Queue", async () => {
  provider.script(["Payment received"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", user: "payer", threadId: "payment" });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: { amount: 100 },
    channelRef: { deliverer: { name: "receipt", ref: { chat: "payer" } } },
  });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(1);
  expect(deliveries[0]).toMatchObject({ key: thread.key, ref: { chat: "payer" } });
  expect(deliveries[0]!.events).toContainEvent({
    type: "turn.completed",
    message: [{ type: "text", text: "Payment received" }],
  });
  expect(deliveries[0]!.events.some((e) => e.type === "message.delta")).toBe(false);
});

it("suppresses a completed reply consumed by a subscriber, then delivers a later offline Turn using the saved route", async () => {
  provider.script(["Online", "Offline"]);
  const thread = scope.thread({ agent: "concierge", threadId: "online" });
  await thread.send({
    kind: "message",
    parts: [{ type: "text", text: "Hello" }],
    channelRef: { deliverer: { name: "receipt", ref: "saved" } },
  });
  await clock.advance(1000);
  expect(deliveries).toEqual([]);
  const offline = karmi.scope("test").thread(thread.key);
  await offline.send({ kind: "event", type: "payment.received", payload: {} });
  await expect.poll(async () => (await offline.events()).filter((e) => e.type === "turn.completed").length).toBe(2);
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(1);
  expect(deliveries[0]).toMatchObject({ ref: "saved" });
  expect(deliveries[0]!.events.every((e) => e.turn === 2)).toBe(true);
});

it("delivers offline Approvals and the completion as separate ranges", async () => {
  provider.script([[reply.toolCall("book", { room: 12 }, "booking")], "Booked"]);
  const thread = karmi.scope("test").thread({ agent: "asking", threadId: "approval-delivery" });
  await thread.send({
    kind: "event",
    type: "booking.requested",
    payload: {},
    channelRef: { deliverer: { name: "receipt", ref: "approver" } },
  });
  await expect.poll(async () => (await thread.status()).state).toBe("parked");
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(1);
  const approval = deliveries[0]!.events.find((e) => e.type === "approval.requested")!;
  await thread.approve(approval.seq, { decision: "allow" });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(2);
  expect(deliveries[1]!.events.every((e) => e.seq > approval.seq)).toBe(true);
  expect(deliveries[1]!.events).toContainEvent({ type: "turn.completed" });
});

it("keeps output available for polling without a Deliverer", async () => {
  provider.script(["Stored"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "no-deliverer" });
  await thread.send({ kind: "event", type: "payment.received", payload: {} });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  await clock.advance(1000);
  expect(deliveries).toEqual([]);
  expect(await thread.events()).toContainEvent({ type: "turn.completed", message: [{ type: "text", text: "Stored" }] });
});

it("retries a failed delivery without failing its Turn and no-ops queued work after Scope destruction", async () => {
  provider.script(["Receipt"]);
  const tenant = karmi.scope("delivery-tenant");
  const thread = tenant.thread({ agent: "concierge", threadId: "retry" });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: {},
    channelRef: { deliverer: { name: "receipt", ref: "retry" } },
  });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  const events = await thread.events();
  const body = {
    kind: "delivery",
    scope: tenant.id,
    threadKey: thread.key,
    fromSeq: events[0]!.seq,
    toSeq: events.at(-1)!.seq,
  };
  const consume = async () => {
    const batch = createMessageBatch("karmi-test-queue", [{ id: "receipt", timestamp: new Date(), body, attempts: 1 }]);
    const ctx = createExecutionContext();
    await karmi.queueHandler(batch, env, ctx);
    return getQueueResult(batch, ctx);
  };
  deliveryFailure.remaining = 1;
  expect(await consume()).toMatchObject({ retryMessages: [{ msgId: "receipt" }] });
  expect(deliveries).toEqual([]);
  expect(await consume()).toMatchObject({ explicitAcks: ["receipt"] });
  expect(deliveries).toHaveLength(1);
  expect(await thread.events()).toContainEvent({ type: "turn.completed" });
  await tenant.destroy();
  expect(await consume()).toMatchObject({ explicitAcks: ["receipt"] });
  await clock.advance(1000);
  expect(deliveries).toHaveLength(1);
});

it("delivers after a subscriber stops before consuming the completion", async () => {
  provider.script(["Unread"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "disconnected" });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: {},
    channelRef: { deliverer: { name: "receipt", ref: "disconnected" } },
  });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  for await (const event of thread.subscribe()) {
    expect(event.type).toBe("turn.started");
    break;
  }
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(1);
  expect(deliveries[0]!.events).toContainEvent({ type: "turn.completed" });
});

it("captures each pending delivery's route before the next inbound input changes it", async () => {
  provider.script(["First", "Second"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "routes" });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: {},
    channelRef: { deliverer: { name: "receipt", ref: "first" } },
  });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: {},
    channelRef: { deliverer: { name: "receipt", ref: "second" } },
  });
  await expect.poll(async () => (await thread.events()).filter((e) => e.type === "turn.completed").length).toBe(2);
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(2);
  expect(deliveries.map((d) => ({ ref: d.ref, turn: d.events[0]!.turn })).sort((a, b) => a.turn - b.turn)).toEqual([
    { ref: "first", turn: 1 },
    { ref: "second", turn: 2 },
  ]);
});

it("rejects an unknown delivery route before accepting the input", async () => {
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "unknown-deliverer" });
  await expect(
    thread.send({
      kind: "event",
      type: "payment.received",
      payload: {},
      channelRef: { deliverer: { name: "missing", ref: "payer" } },
    }),
  ).rejects.toMatchObject({ code: "deliverer.notFound" });
  expect(await thread.events()).toEqual([]);
});

it.each([
  {
    name: "receipt-parts",
    types: ["turn.started", "step.started", "message.part", "usage.recorded", "step.completed", "turn.completed"],
  },
  {
    name: "receipt-deltas",
    types: [
      "turn.started",
      "step.started",
      "message.delta",
      "message.part",
      "usage.recorded",
      "step.completed",
      "turn.completed",
    ],
  },
])("delivers the selected granularity through $name", async ({ name, types }) => {
  provider.script(["Paid"]);
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: name });
  await thread.send({
    kind: "event",
    type: "payment.received",
    payload: {},
    channelRef: { deliverer: { name, ref: "payer" } },
  });
  await expect.poll(async () => (await thread.events()).some((e) => e.type === "turn.completed")).toBe(true);
  await clock.advance(1000);
  await expect.poll(() => deliveries.length).toBe(1);
  expect(deliveries[0]!.events.map((e) => e.type)).toEqual(types);
});
