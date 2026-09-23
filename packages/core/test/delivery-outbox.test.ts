import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { openThreadDatabase } from "../src/db/thread/database";
import { DeliveryOutbox } from "../src/deliverer";

const run = (name: string, test: (outbox: DeliveryOutbox) => void) =>
  runInDurableObject(env.KARMI_THREADS.getByName(`delivery-outbox-${name}`), (_, state) => {
    test(new DeliveryOutbox(openThreadDatabase(state.storage.sql)));
  });

it("adds no range while the Thread has no route", async () => {
  await run("no-route", (outbox) => {
    expect(outbox.enqueue(1, 5, () => 1)).toBe(false);
    expect(outbox.fromSeq(5)).toBeUndefined();
  });
});

it("starts the first range of a Turn at its first event and each later range after the one before", async () => {
  await run("ranges", (outbox) => {
    outbox.route({ name: "push", ref: "a" });
    // An Approval at seq 6, then the end of the Turn at seq 9.
    expect(outbox.enqueue(1, 6, () => 2)).toBe(true);
    expect(
      outbox.enqueue(1, 9, () => {
        throw new Error("A later range does not ask for the first event.");
      }),
    ).toBe(true);
    expect(outbox.enqueue(2, 14, () => 10)).toBe(true);
    expect([outbox.fromSeq(6), outbox.fromSeq(9), outbox.fromSeq(14)]).toEqual([2, 7, 10]);
    expect(() => outbox.enqueue(3, 20, () => undefined)).toThrow("Turn 3 has no first event.");
  });
});

it("drops every range of one Turn and leaves the ranges of other Turns", async () => {
  await run("drop-turn", (outbox) => {
    outbox.route({ name: "push", ref: "a" });
    outbox.enqueue(1, 6, () => 2);
    outbox.enqueue(1, 9, () => 2);
    outbox.enqueue(2, 14, () => 10);
    outbox.dropTurn(1);
    expect([outbox.fromSeq(6), outbox.fromSeq(9), outbox.fromSeq(14)]).toEqual([undefined, undefined, 10]);
    expect(outbox.peek(14)).toEqual({ fromSeq: 10, turn: 2, binding: { name: "push", ref: "a" } });
    expect(outbox.peek(9)).toBeUndefined();
  });
});

it("keeps for each range the route that the Thread had when the range was added", async () => {
  await run("binding", (outbox) => {
    outbox.route({ name: "push", ref: "a" });
    outbox.enqueue(1, 4, () => 1);
    outbox.route({ name: "email", ref: "b" });
    outbox.enqueue(2, 8, () => 5);
    expect(outbox.binding(1, 4)).toEqual({ name: "push", ref: "a" });
    expect(outbox.binding(5, 8)).toEqual({ name: "email", ref: "b" });
    expect(outbox.binding(2, 4)).toBeUndefined();
    outbox.clear();
    expect(outbox.binding(1, 4)).toBeUndefined();
    expect(outbox.enqueue(3, 12, () => 9)).toBe(false);
  });
});
