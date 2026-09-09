import type { ThreadEventType } from "../src/index.js";
import type { EventPartial } from "../src/testing/index.js";

// Test-kit matchers, registered by test/setup.ts.
declare module "vitest" {
  interface Assertion<T> {
    toContainEvent(partial: EventPartial): T;
    toHaveSequence(types: ThreadEventType[]): T;
  }
}
