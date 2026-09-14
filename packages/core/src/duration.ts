const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `"1.5h"` in milliseconds; NaN when the text is not a duration. */
export function parseDuration(text: string): number {
  const [, amount, unit = ""] = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text) ?? [];
  return Number(amount) * (UNITS[unit] ?? NaN);
}

/** A number is milliseconds as given; a string is a duration such as `"24h"`. NaN when neither. */
export function milliseconds(duration: number | string): number {
  return typeof duration === "number" ? duration : parseDuration(duration);
}
