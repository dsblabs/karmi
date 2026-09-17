import type { ThreadEventType } from "@karmi/core";
import type { EventPartial } from "@karmi/core/testing";

// The test-kit matchers, registered by test/setup.ts.
declare module "vitest" {
  interface Assertion<T> {
    toContainEvent(partial: EventPartial): T;
    toHaveSequence(types: ThreadEventType[]): T;
  }
}
