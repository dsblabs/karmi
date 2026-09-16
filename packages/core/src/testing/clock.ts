import type { KarmiBindings } from "../bindings";
import type { Clock } from "../clock";
import { milliseconds as toMilliseconds } from "../duration";

/** The Test kit's Clock. It reads wall time plus an offset that `advance` moves forward. */
export interface TestClock extends Clock {
  /**
   * Moves time forward by `duration` (milliseconds or a string such as `"24h"`) and fires every Durable
   * Object alarm of this test Worker that is now due.
   */
  advance(duration: number | string): Promise<void>;
}

/** Creates the Test kit's Clock for the Durable Object namespaces in `bindings`. */
export function testClock(bindings: KarmiBindings): TestClock {
  let offset = 0;
  const clock: TestClock = {
    now: () => Date.now() + offset,
    async advance(duration) {
      const ms = toMilliseconds(duration);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid clock duration "${duration}".`);
      offset += ms;
      const { listDurableObjectIds, runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
      let ran: boolean;
      do {
        ran = false;
        for (const namespace of [bindings.KARMI_SCOPES, bindings.KARMI_THREADS, bindings.KARMI_KNOWLEDGE]) {
          if (!namespace) continue;
          for (const id of await listDurableObjectIds(namespace)) {
            const stub = namespace.get(id);
            const at = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
            if (at !== null && at <= clock.now()) ran = (await runDurableObjectAlarm(stub)) || ran;
          }
        }
      } while (ran);
    },
  };
  return clock;
}
