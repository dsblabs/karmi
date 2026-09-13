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

export interface TestThread extends Omit<Thread, "send"> {
  /** Resolves when the Turn ends or parks (completed, failed or paused) with everything it logged from this call on. */
  send(input: TurnInput, options?: SendOptions): Promise<ThreadEvent[]>;
}

export interface TestScope extends Omit<Scope, "thread"> {
  thread(target: ThreadIdentity | string): TestThread;
}

export interface TestKarmi {
  karmi: Karmi;
  clock: TestClock;
  /** Every Agent runs against this one; script it per test with `provider.script(...)`. */
  provider: FakeProvider;
  /** The in-memory SecretsProvider every `scope:<name>` reference resolves through, unless `options.secrets` replaced it. */
  secrets: MemorySecrets;
  /** The Scope `test`, ready to use. */
  scope: TestScope;
}

/**
 * A karmi for the test Worker: the Catalogue under test, a fake Provider named `fake` that serves every
 * model id, an in-memory SecretsProvider, and the Scope `test`. Export `karmi.durableObjects` from the same module.
 */
export interface TestKarmiOptions extends Omit<KarmiOptions, "catalogue" | "clock"> {
  /** In-process MCP servers the Scope's `scopedFetch` reaches by their `url`; register them in the Scope config. */
  mcpServers?: FakeMcpServer[];
}

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
    // A client identity out of the box, so an OAuth fake needs no more than `mcpServers`.
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
