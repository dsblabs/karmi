import { KarmiError } from "./errors.js";
import { assertName } from "./names.js";
import type { Granularity, ThreadEvent } from "./thread-events.js";

/** A Channel's offline sink. Calls are at-least-once; deduplicate by Thread key and event seq. */
export interface Deliverer {
  name: string;
  granularity?: Granularity;
  deliver(threadKey: string, events: ThreadEvent[], ref: unknown): void | Promise<void>;
}

export interface DeliveryBinding {
  name: string;
  ref: unknown;
}

export function defineDeliverer(input: Deliverer): Deliverer {
  assertName("deliverer", input.name);
  if (input.granularity !== undefined && !["delta", "part", "turn"].includes(input.granularity)) throw new KarmiError("deliverer.invalid", "Deliverer granularity must be delta, part or turn.");
  return Object.freeze({ ...input });
}

/** channelRef remains opaque except for this opt-in Channel routing field. */
export function deliveryBinding(channelRef: unknown): DeliveryBinding | undefined {
  if (typeof channelRef !== "object" || channelRef === null || !("deliverer" in channelRef)) return;
  const value = channelRef.deliverer;
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string" || !("ref" in value)) throw new KarmiError("deliverer.invalid", "channelRef.deliverer requires { name, ref }.");
  assertName("deliverer", value.name);
  return { name: value.name, ref: value.ref };
}
