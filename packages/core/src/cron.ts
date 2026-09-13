// Five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA zone. Pure: the
// caller supplies the instant to search from. Day-of-month and day-of-week combine as Vixie cron does:
// when both are restricted, either matching is a match.

export interface CronExpression {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Whether each day field was `*`, which decides how the two combine. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE = 60_000;
/** Nothing legitimate is further away than this many minute-steps; the search stops rather than spin. */
const SEARCH_LIMIT = 200_000;

/** The parsed expression, or undefined when the text is not valid cron. */
export function parseCron(text: string): CronExpression | undefined {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const parsed = {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12, MONTHS),
    dayOfWeek: parseField(dayOfWeek, 0, 7, DAYS),
  };
  if (Object.values(parsed).some((set) => set === undefined)) return undefined;
  const week = parsed.dayOfWeek as Set<number>;
  // Both 0 and 7 are Sunday.
  if (week.has(7)) (week.delete(7), week.add(0));
  return {
    minute: parsed.minute as Set<number>,
    hour: parsed.hour as Set<number>,
    dayOfMonth: parsed.dayOfMonth as Set<number>,
    month: parsed.month as Set<number>,
    dayOfWeek: week,
    anyDayOfMonth: dayOfMonth === "*",
    anyDayOfWeek: dayOfWeek === "*",
  };
}

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/") as [string, string?];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || !/^\d+$/.test(stepText ?? "1")) return undefined;
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [min, max];
    else {
      const [a, b] = range.split("-") as [string, string?];
      const low = parseValue(a, names);
      if (low === undefined) return undefined;
      from = low;
      if (b === undefined) to = stepText === undefined ? low : max;
      else {
        const high = parseValue(b, names);
        if (high === undefined) return undefined;
        to = high;
      }
    }
    if (from < min || to > max || from > to) return undefined;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function parseValue(text: string, names?: string[]): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const index = names?.indexOf(text.toLowerCase()) ?? -1;
  if (index < 0) return undefined;
  return names === MONTHS ? index + 1 : index;
}

/** Whether `tz` is a zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, format);
  }
  return format;
}

interface LocalTime {
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

function localTime(ms: number, tz: string): LocalTime {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: DAYS.indexOf((parts.weekday ?? "").toLowerCase()),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function dayMatches(cron: CronExpression, local: LocalTime): boolean {
  const byMonth = cron.dayOfMonth.has(local.day);
  const byWeek = cron.dayOfWeek.has(local.weekday);
  if (cron.anyDayOfMonth) return byWeek;
  if (cron.anyDayOfWeek) return byMonth;
  return byMonth || byWeek;
}

/**
 * The first firing strictly after `after`, as epoch milliseconds, or undefined when the expression is
 * invalid or never fires. Jumps by the remainder of the day or hour when those fields miss, so a sparse
 * expression is found in a few hundred steps and a DST gap simply fails to match and moves on.
 */
export function nextCronTime(expression: string | CronExpression, after: number, tz: string): number | undefined {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  if (!cron) return undefined;
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const local = localTime(t, tz);
    if (!cron.month.has(local.month) || !dayMatches(cron, local))
      t += (24 * 60 - (local.hour * 60 + local.minute)) * MINUTE;
    else if (!cron.hour.has(local.hour)) t += (60 - local.minute) * MINUTE;
    else if (!cron.minute.has(local.minute)) t += MINUTE;
    else return t;
  }
  return undefined;
}
