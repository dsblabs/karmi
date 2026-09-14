import type { Logger } from "./context";
import { isSensitiveValue } from "./secrets";

const SENSITIVE_VALUE = "[SensitiveValue]";
const REDACTED = "[REDACTED]";
/** Field names whose value is a credential by convention, whatever type it has. */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|api[_-]?key|cookie)$/i;
/** An HTTP credential inside free text. Only the scheme survives. */
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g;

/**
 * The default Logger. It writes one JSON line per call to the Worker console, so Workers Observability
 * indexes every field. It expects fields already redacted by `bindLogger`.
 */
export function consoleLogger(): Logger {
  const line = (level: keyof Logger, message: string, fields?: Record<string, unknown>) =>
    console[level](JSON.stringify({ level, message, ...fields }));
  return {
    debug: (message, fields) => line("debug", message, fields),
    info: (message, fields) => line("info", message, fields),
    warn: (message, fields) => line("warn", message, fields),
    error: (message, fields) => line("error", message, fields),
  };
}

/**
 * A Logger that adds `fields` to every call of `base` and redacts the result. A `SensitiveValue`, a field
 * named like a credential, and a bearer token inside text never reach `base`.
 */
export function bindLogger(base: Logger, fields: Record<string, unknown>): Logger {
  const merge = (extra?: Record<string, unknown>) => redactFields({ ...fields, ...extra });
  return {
    debug: (message, extra) => base.debug(message, merge(extra)),
    info: (message, extra) => base.info(message, merge(extra)),
    warn: (message, extra) => base.warn(message, merge(extra)),
    error: (message, extra) => base.error(message, merge(extra)),
  };
}

/** Returns a copy of `fields` with every credential replaced by a marker, at any depth. */
export function redactFields(fields: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactValue(key, value)]));
}

function redactValue(key: string, value: unknown): unknown {
  if (isSensitiveValue(value)) return SENSITIVE_VALUE;
  if (SECRET_KEY.test(key) && value !== undefined && value !== null) return REDACTED;
  if (typeof value === "string") return value.replace(BEARER, `$1 ${REDACTED}`);
  if (Array.isArray(value)) return value.map((entry) => redactValue("", entry));
  if (value === null || typeof value !== "object") return value;
  // An object with its own `toJSON` (a Date, say) is left to serialise itself.
  if ("toJSON" in value && typeof value.toJSON === "function") return value;
  return redactFields(value);
}
