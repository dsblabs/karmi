import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { openThreadDatabase } from "../src/db/thread/database";
import { InputQueue } from "../src/input-queue";
import type { TurnInput } from "../src/thread-events";

const message = (text: string): TurnInput => ({ kind: "message", parts: [{ type: "text", text }] });
const run = (name: string, test: (queue: InputQueue) => void) =>
  runInDurableObject(env.KARMI_THREADS.getByName(`input-queue-${name}`), (_, state) => {
    test(new InputQueue(openThreadDatabase(state.storage.sql)));
  });

it("takes the inputs of a Turn and of each Turn before it, oldest first, and leaves the later ones", async () => {
  await run("turns", (queue) => {
    expect(queue.isEmpty()).toBe(true);
    expect(queue.first()).toBeUndefined();
    queue.add(1, message("a"), false);
    queue.add(2, message("b"), false);
    const later = queue.add(3, message("c"), false);
    expect(queue.first()).toEqual(message("a"));
    expect(queue.takeThrough(2)).toEqual([message("a"), message("b")]);
    expect(queue.takeThrough(2)).toEqual([]);
    expect(queue.has(later)).toBe(true);
    expect(queue.isEmpty()).toBe(false);
    queue.clear();
    expect(queue.has(later)).toBe(false);
    expect(queue.isEmpty()).toBe(true);
  });
});

it("takes only the steer inputs at a batch boundary", async () => {
  await run("steers", (queue) => {
    queue.add(1, message("steer 1"), true);
    const next = queue.add(2, message("next Turn"), false);
    queue.add(1, message("steer 2"), true);
    expect(queue.takeSteers()).toEqual([message("steer 1"), message("steer 2")]);
    expect(queue.takeSteers()).toEqual([]);
    expect(queue.has(next)).toBe(true);
  });
});

it("gives a steer input that missed its Turn to the next Turn", async () => {
  await run("late-steer", (queue) => {
    queue.add(1, message("late steer"), true);
    queue.add(2, message("next Turn"), false);
    expect(queue.takeThrough(2)).toEqual([message("late steer"), message("next Turn")]);
  });
});
