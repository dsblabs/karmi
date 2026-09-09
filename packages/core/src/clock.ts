/** The Harness's single source of wall time, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

export const wallClock: Clock = { now: () => Date.now() };
