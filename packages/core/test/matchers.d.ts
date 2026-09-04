import type { ThreadEvent, ThreadEventType } from "../src/index.js";

// Test-kit matchers, registered by test/setup.ts.
declare module "vitest" {
  interface Assertion<T> {
    toContainEvent(partial: Partial<ThreadEvent> & { type: ThreadEventType }): T;
    toHaveSequence(types: ThreadEventType[]): T;
  }
}
