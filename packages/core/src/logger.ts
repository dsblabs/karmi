import type { Logger } from "./context.js";

/** The default Logger: structured lines on the Worker console, each carrying the fields it was opened with. */
export function consoleLogger(fields: Record<string, unknown>): Logger {
  const line = (level: keyof Logger, message: string, extra?: Record<string, unknown>) =>
    console[level](JSON.stringify({ level, message, ...fields, ...extra }));
  return {
    debug: (message, extra) => line("debug", message, extra),
    info: (message, extra) => line("info", message, extra),
    warn: (message, extra) => line("warn", message, extra),
    error: (message, extra) => line("error", message, extra),
  };
}
