import { and, eq, max } from "drizzle-orm";
import type { ThreadDatabase } from "./db/thread/database";
import { deliveries, deliveryRoutes } from "./db/thread/schema";
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

// This is the only decode point for the stored bindings. The rows are the Thread's own, so the shape is trusted.
const decodeBinding = (value: DeliveryBinding): DeliveryBinding => value;

/**
 * The Outbox of one Thread for event ranges that wait for a Deliverer, and the route that the last Turn input
 * selected. It never sends a range and never sets an Alarm.
 */
export class DeliveryOutbox {
  constructor(private db: ThreadDatabase) {}

  /** Makes `binding` the route of the Thread. It replaces the route before it. */
  route(binding: DeliveryBinding): void {
    this.db
      .insert(deliveryRoutes)
      .values({ id: 1, binding })
      .onConflictDoUpdate({ target: deliveryRoutes.id, set: { binding } })
      .run();
  }

  /**
   * Adds the range that ends at the event `toSeq` of `turn`, under the route of the Thread. The range starts
   * after the last range of the Turn, or at `firstSeq()` for the first range of the Turn. Returns false and
   * adds nothing when the Thread has no route. Call it in the same synchronous write as the event.
   */
  enqueue(turn: number, toSeq: number, firstSeq: () => number | undefined): boolean {
    const route = this.db.select({ binding: deliveryRoutes.binding }).from(deliveryRoutes).get();
    if (!route) return false;
    const previous = this.db
      .select({ seq: max(deliveries.toSeq) })
      .from(deliveries)
      .where(eq(deliveries.turn, turn))
      .get()?.seq;
    const fromSeq = previous === null || previous === undefined ? firstSeq() : previous + 1;
    if (fromSeq === undefined) throw new Error(`Turn ${turn} has no first event.`);
    this.db.insert(deliveries).values({ toSeq, fromSeq, turn, binding: route.binding }).run();
    return true;
  }

  /** The first `seq` of the range that ends at `toSeq`, or undefined when no such range waits. */
  fromSeq(toSeq: number): number | undefined {
    return this.db.select({ fromSeq: deliveries.fromSeq }).from(deliveries).where(eq(deliveries.toSeq, toSeq)).get()
      ?.fromSeq;
  }

  /** The route that the range had when it was added, or undefined when no such range waits. */
  binding(fromSeq: number, toSeq: number): DeliveryBinding | undefined {
    const row = this.db
      .select({ binding: deliveries.binding })
      .from(deliveries)
      .where(and(eq(deliveries.fromSeq, fromSeq), eq(deliveries.toSeq, toSeq)))
      .get();
    return row && decodeBinding(row.binding);
  }

  /** Removes every range and the route. */
  clear(): void {
    this.db.delete(deliveries).run();
    this.db.delete(deliveryRoutes).run();
  }
}
