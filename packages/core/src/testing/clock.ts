import type { KarmiBindings } from "../bindings";
import type { Clock } from "../clock";
import { milliseconds as toMilliseconds } from "../duration";

export interface TestClock extends Clock {
  /** Move time forward and fire the due alarms of this test Worker's Durable Objects. */
  advance(duration: number | string): Promise<void>;
}

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
        for (const namespace of [bindings.KARMI_SCOPES, bindings.KARMI_THREADS]) {
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
