import { env } from "cloudflare:workers";
import { resolveBindings } from "../bindings";
import { testClock, type TestClock } from "./clock";
import type { CatalogueInput } from "../catalogue";
import { createKarmi, type Karmi, type KarmiOptions } from "../karmi";
import type { Scope } from "../scope";
import { isTurnEnd } from "../thread-do";
import type { SendOptions, Thread, ThreadIdentity } from "../thread";
import type { ThreadEvent, TurnInput } from "../thread-events";
import { fakeProvider, type FakeProvider } from "./fake-provider";
import { routeFetch, type FakeMcpServer } from "./fake-mcp-server";
import { memorySecrets, type MemorySecrets } from "./memory-secrets";

/** A Thread whose `send` waits for the Turn to end. */
export interface TestThread extends Omit<Thread, "send"> {
  /** Sends the input and resolves with every event the Turn logged once it completes, fails or is Parked. */
  send(input: TurnInput, options?: SendOptions): Promise<ThreadEvent[]>;
}

/** A Scope whose Threads are `TestThread`s. */
export interface TestScope extends Omit<Scope, "thread"> {
  thread(target: ThreadIdentity | string): TestThread;
}

/** What `createTestKarmi` returns: the karmi under test and the doubles it was built with. */
export interface TestKarmi {
  karmi: Karmi;
  /** The Clock every time-driven part of `karmi` reads. `clock.advance` moves it. */
  clock: TestClock;
  /** The fake Provider every Agent runs against. Script it per test with `provider.script(...)`. */
  provider: FakeProvider;
  /**
   * The in-memory SecretsProvider every `scope:<name>` reference resolves through, unless `options.secrets`
   * replaced it.
   */
  secrets: MemorySecrets;
  /** The Scope `test`, ready to use. */
  scope: TestScope;
}

/** Options for `createTestKarmi`. The Test kit supplies `catalogue` and `clock` itself. */
export interface TestKarmiOptions extends Omit<KarmiOptions, "catalogue" | "clock"> {
  /** In-process MCP servers the Scope's Scoped fetch routes to by `url`. Register each in the Scope config too. */
  mcpServers?: FakeMcpServer[];
}

/**
 * Creates a karmi for the test Worker. It runs the Catalogue under test against a fake Provider named `fake`
 * that serves every model id, an in-memory SecretsProvider, and the Scope `test`. Export
 * `karmi.durableObjects` from the same module.
 */
export function createTestKarmi(catalogue: CatalogueInput, options: TestKarmiOptions = {}): TestKarmi {
  const clock = testClock(resolveBindings(env, options.bindings));
  const provider = fakeProvider(["OK"]);
  const secrets = memorySecrets();
  const defaults = {
    ...options.defaults,
    providers: { default: { adapter: "fake", models: ["*"] }, ...options.defaults?.providers },
  };
  const { mcpServers, ...rest } = options;
  const karmi = createKarmi({
    // A default Client identity, so a test with an OAuth fake needs no more than `mcpServers`.
    oauth: { origin: "https://karmi.test", clientName: "karmi test" },
    ...rest,
    ...(mcpServers && { fetch: routeFetch(mcpServers, options.fetch) }),
    clock,
    catalogue,
    defaults,
    providers: { ...options.providers, fake: provider },
    secrets: options.secrets ?? secrets,
  });
  const scope = karmi.scope("test");
  return {
    karmi,
    clock,
    provider,
    secrets,
    scope: { ...scope, thread: (target) => testThread(scope.thread(target)) },
  };
}

function testThread(thread: Thread): TestThread {
  return {
    ...thread,
    async send(input, options) {
      const { turn, seq } = await thread.send(input, options);
      const events: ThreadEvent[] = [];
      for await (const event of thread.subscribe({ after: seq })) {
        if (event.turn !== turn) continue;
        events.push(event);
        if (isTurnEnd(event)) break;
      }
      return events;
    },
  };
}
