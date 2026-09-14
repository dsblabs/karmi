import { KarmiError } from "./errors";
import { assertName } from "./names";
import type { Granularity, ThreadEvent } from "./thread-events";

/**
 * A Catalogue item that pushes a Thread's output to a Channel when no live subscriber is attached. Calls are
 * at-least-once, so implementations deduplicate by Thread key and event `seq`.
 */
export interface Deliverer {
  name: string;
  /**
   * Which events reach `deliver`: streamed deltas, completed parts or one message per Turn. Defaults to
   * `part`.
   */
  granularity?: Granularity;
  /** Pushes `events` of the Thread at `threadKey` to the Channel. `ref` is the value the Turn input bound. */
  deliver(threadKey: string, events: ThreadEvent[], ref: unknown): void | Promise<void>;
}

/**
 * The Deliverer a Thread routes offline output to, as named by the last Turn input's `channelRef.deliverer`.
 */
export interface DeliveryBinding {
  /** The Catalogue name of the Deliverer. */
  name: string;
  /** The opaque value handed back to the Deliverer on every call. */
  ref: unknown;
}

/**
 * Validates a Deliverer definition and returns it frozen. Throws `deliverer.invalid` on a bad name or
 * granularity.
 */
export function defineDeliverer(input: Deliverer): Deliverer {
  assertName("deliverer", input.name);
  if (input.granularity !== undefined && !["delta", "part", "turn"].includes(input.granularity))
    throw new KarmiError("deliverer.invalid", "Deliverer granularity must be delta, part or turn.");
  return Object.freeze({ ...input });
}

/**
 * Reads the `deliverer` field of a Turn input's `channelRef`, or returns undefined when there is none. This is
 * the only field of `channelRef` the Framework interprets. Throws `deliverer.invalid` when the field is not
 * `{ name, ref }`.
 */
export function deliveryBinding(channelRef: unknown): DeliveryBinding | undefined {
  if (typeof channelRef !== "object" || channelRef === null || !("deliverer" in channelRef)) return;
  const value = channelRef.deliverer;
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("ref" in value)
  )
    throw new KarmiError("deliverer.invalid", "channelRef.deliverer requires { name, ref }.");
  assertName("deliverer", value.name);
  return { name: value.name, ref: value.ref };
}
