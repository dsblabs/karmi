import type { Logger } from "./context";
import { redact } from "./secrets";

/**
 * The default Logger. It writes one JSON line per call to the Worker console, carrying `fields` on every
 * line. Sensitive values print redacted.
 */
export function consoleLogger(fields: Record<string, unknown>): Logger {
  const line = (level: keyof Logger, message: string, extra?: Record<string, unknown>) =>
    console[level](JSON.stringify(redact({ level, message, ...fields, ...extra })));
  return {
    debug: (message, extra) => line("debug", message, extra),
    info: (message, extra) => line("info", message, extra),
    warn: (message, extra) => line("warn", message, extra),
    error: (message, extra) => line("error", message, extra),
  };
}
