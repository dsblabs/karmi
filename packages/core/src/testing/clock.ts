import type { KarmiBindings } from "../bindings.js";
import type { Clock } from "../clock.js";

export interface TestClock extends Clock {
  /** Move time forward and fire the due alarms of this test Worker's Durable Objects. */
  advance(duration: number | string): Promise<void>;
}

export function testClock(bindings: KarmiBindings): TestClock {
  let offset = 0;
  const clock: TestClock = {
    now: () => Date.now() + offset,
    async advance(duration) {
      const ms = milliseconds(duration);
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

function milliseconds(duration: number | string): number {
  const match = typeof duration === "string" ? /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration) : null;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = typeof duration === "number" ? duration : match ? Number(match[1]) * units[match[2]!]! : NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid clock duration "${duration}".`);
  return ms;
}
