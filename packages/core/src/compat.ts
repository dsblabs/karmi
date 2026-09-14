import { KarmiError } from "./errors";

/** The oldest wrangler `compatibility_date` karmi runs on (ADR-0002). */
export const COMPATIBILITY_DATE_FLOOR = "2026-08-04";

/**
 * Throws `compatibility.date` when `globals` lacks the Node globals that `compatibility_date` on or after
 * the floor turns on. workerd exposes no compatibility date at runtime, so the floor is checked by its
 * consequence. An older date with an explicit `nodejs_compat` flag passes this check, and only
 * `karmi doctor` reads the real date from the config.
 */
export function assertCompatibilityBaseline(globals: object = globalThis): void {
  const process = (globals as { process?: { nextTick?: unknown } }).process;
  if (typeof process?.nextTick !== "function") {
    throw new KarmiError(
      "compatibility.date",
      `karmi requires compatibility_date >= ${COMPATIBILITY_DATE_FLOOR} (ADR-0002); set it in wrangler.jsonc.`,
    );
  }
}
