import type { CatalogueInput } from "../catalogue.js";
import { createKarmi, type Karmi, type KarmiOptions } from "../karmi.js";
import type { Scope } from "../scope.js";
import type { Thread, ThreadIdentity } from "../thread.js";
import type { ThreadEvent, TurnInput } from "../thread-events.js";
import { fakeProvider, type FakeProvider } from "./fake-provider.js";

export interface TestThread extends Omit<Thread, "send"> {
  /** Resolves when the Turn ends (completed, failed or paused) with everything it logged. */
  send(input: TurnInput): Promise<ThreadEvent[]>;
}

export interface TestScope extends Omit<Scope, "thread"> {
  thread(target: ThreadIdentity | string): TestThread;
}

export interface TestKarmi {
  karmi: Karmi;
  /** Every Agent runs against this one; script it per test with `provider.script(...)`. */
  provider: FakeProvider;
  /** The Scope `test`, ready to use. */
  scope: TestScope;
}

/**
 * A karmi for the test Worker: the Catalogue under test, a fake Provider named `fake` that serves every
 * model id, and the Scope `test`. Export `karmi.durableObjects` from the same module.
 */
export function createTestKarmi(catalogue: CatalogueInput, options: Omit<KarmiOptions, "catalogue"> = {}): TestKarmi {
  const provider = fakeProvider(["OK"]);
  const defaults = { ...options.defaults, providers: { default: { adapter: "fake", models: ["*"] }, ...options.defaults?.providers } };
  const karmi = createKarmi({ ...options, catalogue, defaults, providers: { ...options.providers, fake: provider } });
  const scope = karmi.scope("test");
  return { karmi, provider, scope: { ...scope, thread: (target) => testThread(scope.thread(target)) } };
}

function testThread(thread: Thread): TestThread {
  return {
    ...thread,
    async send(input) {
      const { turn, seq } = await thread.send(input);
      const events: ThreadEvent[] = [];
      for await (const event of thread.subscribe({ after: seq })) {
        if (event.turn !== turn) continue;
        events.push(event);
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
      }
      return events;
    },
  };
}
