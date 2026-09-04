import { KarmiError } from "./errors.js";

export const COMPATIBILITY_DATE_FLOOR = "2026-08-04";

/**
 * workerd exposes no compatibility date at runtime, so the floor is checked by its consequence:
 * from 2026-08-04 `nodejs_compat` is on by default and the Node globals exist. An older date with an
 * explicit `nodejs_compat` flag slips through here; `karmi doctor` reads the real date from the config.
 */
export function assertCompatibilityBaseline(globals: object = globalThis): void {
  const process = (globals as { process?: { nextTick?: unknown } }).process;
  if (typeof process?.nextTick !== "function") {
    throw new KarmiError("compatibility.date", `karmi requires compatibility_date >= ${COMPATIBILITY_DATE_FLOOR} (ADR-0002); set it in wrangler.jsonc.`);
  }
}
