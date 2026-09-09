import type { ThreadEvent, ThreadEventType } from "../thread-events.js";

type MatcherResult = { pass: boolean; message: () => string };

type DeepPartial<T> = T extends readonly (infer Item)[] ? DeepPartial<Item>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
/** A `type` plus any subset of that event's fields, nested objects partially too. */
export type EventPartial = { [T in ThreadEventType]: DeepPartial<Extract<ThreadEvent, { type: T }>> & { type: T } }[ThreadEventType];

/** `expect.extend(matchers)` once per test file (or in a vitest setup file) makes these available. */
export const matchers = {
  /** Some event in the list matches the partial, `expect.objectContaining` style. */
  toContainEvent(received: ThreadEvent[], partial: EventPartial): MatcherResult {
    const pass = received.some((event) => matches(event, partial));
    return { pass, message: () => `expected events ${pass ? "not " : ""}to contain ${JSON.stringify(partial)}; types seen: ${received.map((event) => event.type).join(", ")}` };
  },
  /** The listed types occur in this order, other events allowed in between. */
  toHaveSequence(received: ThreadEvent[], types: ThreadEventType[]): MatcherResult {
    let next = 0;
    for (const event of received) if (next < types.length && event.type === types[next]) next++;
    const pass = next === types.length;
    return { pass, message: () => `expected events ${pass ? "not " : ""}to have sequence ${types.join(" → ")}; got ${received.map((event) => event.type).join(" → ")}` };
  },
};

/** The assistant's final text of a Turn: from `turn.completed`, else the last text part seen. */
export function lastMessage(events: ThreadEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "turn.completed") return event.message.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (event.type === "message.part" && event.block.type === "text") return event.block.text;
  }
  return undefined;
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matches(actual[i], item));
  return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
}
