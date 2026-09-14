/** The Harness's single source of wall time, in milliseconds since the Unix epoch. */
export interface Clock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default Clock, which reads `Date.now()`. */
export const wallClock: Clock = { now: () => Date.now() };
