import { eq, inArray, max } from "drizzle-orm";
import type { ThreadDatabase } from "./db/thread/database";
import { deliveries, deliveryRoutes } from "./db/thread/schema";
import { KarmiError } from "./errors";
import { assertName } from "./names";
import type { Granularity, ThreadEvent } from "./thread-events";

/**
 * The context a Deliverer receives with the events of one call. It carries the Scope and the Thread that made
 * the events, and the value that the Turn input bound.
 */
export interface DelivererContext {
  /** The id of the Scope that owns the Thread. A Thread key is unique only in one Scope. */
  scope: string;
  /** The key of the Thread that made the events. */
  threadKey: string;
  /** The value that the Turn input bound in `channelRef.deliverer.ref`. */
  ref: unknown;
}

/**
 * A Catalogue item that pushes a Thread's output to a Channel when no live subscriber is attached. Calls are
 * at-least-once, so implementations deduplicate by Scope id, Thread key and event `seq`.
 */
export interface Deliverer {
  name: string;
  /**
   * Which events reach `deliver`: streamed deltas, completed parts or one message per Turn. Defaults to
   * `part`.
   */
  granularity?: Granularity;
  /** Pushes `events` to the Channel. `ctx` names the Scope and the Thread that made them. */
  deliver(events: ThreadEvent[], ctx: DelivererContext): void | Promise<void>;
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
  return decodeDeliveryRoute(channelRef.deliverer, "channelRef.deliverer requires { name, ref }.");
}

/**
 * Reads `{ name, ref }` as a Deliverer route. Throws `deliverer.invalid` when the shape is wrong.
 */
export function decodeDeliveryRoute(
  value: unknown,
  invalid = "A delivery route requires { name, ref }.",
): DeliveryBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("ref" in value)
  )
    throw new KarmiError("deliverer.invalid", invalid);
  assertName("deliverer", value.name);
  return { name: value.name, ref: value.ref };
}

// This is the only decode point for the stored bindings. The rows are the Thread's own, so the shape is trusted.
const decodeBinding = (value: DeliveryBinding): DeliveryBinding => value;

/**
 * The Outbox of one Thread for event ranges the Queue has not accepted, and the route that the last Turn
 * input selected. It never sends a range and never sets an Alarm.
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

  /** The range that ends at `toSeq`, or undefined when no such range waits. */
  range(toSeq: number): { fromSeq: number; turn: number; binding: DeliveryBinding } | undefined {
    const row = this.db.select().from(deliveries).where(eq(deliveries.toSeq, toSeq)).get();
    return row && { fromSeq: row.fromSeq, turn: row.turn, binding: decodeBinding(row.binding) };
  }

  /** The first `seq` of the range that ends at `toSeq`, or undefined when no such range waits. */
  fromSeq(toSeq: number): number | undefined {
    return this.range(toSeq)?.fromSeq;
  }

  /** The route that the range had when it was added, or undefined when no such range waits. */
  binding(fromSeq: number, toSeq: number): DeliveryBinding | undefined {
    const row = this.range(toSeq);
    return row?.fromSeq === fromSeq ? row.binding : undefined;
  }

  /**
   * Removes every range whose Alarm has run, except the ranges of `openTurn`. `enqueue` needs those as the
   * cursor of the Turn. Leaves the route.
   */
  dropSent(openTurn: number | undefined, pending: (toSeq: number) => boolean): void {
    const rows = this.db.select({ toSeq: deliveries.toSeq, turn: deliveries.turn }).from(deliveries).all();
    const sent = rows.filter((row) => row.turn !== openTurn && !pending(row.toSeq)).map((row) => row.toSeq);
    if (sent.length > 0) this.db.delete(deliveries).where(inArray(deliveries.toSeq, sent)).run();
  }

  /** Removes every range and the route. */
  clear(): void {
    this.db.delete(deliveries).run();
    this.db.delete(deliveryRoutes).run();
  }
}
