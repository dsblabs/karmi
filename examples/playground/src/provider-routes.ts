import { KarmiError, type Scope, type Thread, type ThreadEvent } from "@karmi/core";
import {
  decodeSettings,
  PROVIDER_DESK,
  providerDeskSpec,
  PROVIDERS,
  settingsOf,
  STARTING_SETTINGS,
  WEB_SEARCH,
} from "./provider-desk";
import type { ProfileChoice } from "./providers";
import { routeError, specRejected } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface ProviderRouteOptions {
  /** Opens the sample Scope. */
  scope: () => Scope;
  scopeId: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
  /** The Deployment profiles of setup. The first one is `default`. Empty without setup. */
  profiles: readonly ProfileChoice[];
}

/** The Thread of the current generation of the scenario. */
async function current(
  options: ProviderRouteOptions,
): Promise<{ stub: DurableObjectStub<SampleDataDO>; thread: Thread }> {
  const stub = sampleData(options.data, options.scopeId, PROVIDERS);
  const { generation } = await stub.read();
  const thread = options
    .scope()
    .thread({ agent: PROVIDER_DESK, user: options.user, threadId: `${PROVIDER_DESK}-${String(generation)}` });
  return { stub, thread };
}

/** Stores the starting Spec: the `default` profile without the Provider Tool. */
async function storeStartingSpec(options: ProviderRouteOptions): Promise<void> {
  const [first] = options.profiles;
  if (first) await options.scope().agents.put(providerDeskSpec(first, { profile: first.name, ...STARTING_SETTINGS }));
}

/**
 * Returns the stored Spec. It stores the starting Spec first when the Scope has none, or when the stored one names a
 * profile or a model that setup no longer has, for example after `pnpm setup` selected a different Provider.
 */
async function storedSpec(options: ProviderRouteOptions) {
  const scope = options.scope();
  const read = async () =>
    (await scope.agents.list()).some((agent) => agent.agentId === PROVIDER_DESK)
      ? scope.agents.get(PROVIDER_DESK)
      : undefined;
  const stored = await read();
  const { model } = stored?.spec ?? {};
  const known = options.profiles.some((choice) => choice.name === model?.providerProfile && choice.model === model.id);
  if (known) return stored;
  await storeStartingSpec(options);
  return read();
}

/** Each model Step of the Thread: the profile, the adapter and the model that it ran on. */
const stepsOf = (events: ThreadEvent[]) =>
  events.flatMap((event) =>
    event.type === "step.started" && event.kind === "model"
      ? [
          {
            seq: event.seq,
            turn: event.turn,
            profile: event.profile,
            provider: event.provider,
            model: event.model,
            agentVersion: event.agentVersion,
          },
        ]
      : [],
  );

/** One Tool call of the Thread, with where it ran: in the Worker by the Harness, or at the Provider. */
interface CallView {
  seq: number;
  id: string;
  name: string;
  runsAt: "harness" | "provider";
  input: unknown;
  /** The result text: the Tool result, or the summary of the Provider Tool result. */
  result?: string;
  isError?: boolean;
}

/** Reads each Tool call and each Provider Tool call from the event log, with its result. */
function callsOf(events: ThreadEvent[]): CallView[] {
  const calls = new Map<string, CallView>();
  for (const event of events) {
    switch (event.type) {
      case "tool.call":
      case "server_tool.called": {
        const runsAt = event.type === "tool.call" ? "harness" : "provider";
        calls.set(event.id, { seq: event.seq, id: event.id, name: event.name, runsAt, input: event.input });
        break;
      }
      case "tool.result": {
        const call = calls.get(event.id);
        if (!call) break;
        call.result = event.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
        call.isError = event.isError;
        break;
      }
      case "server_tool.result": {
        const call = calls.get(event.id);
        if (call) call.result = event.summary;
        break;
      }
    }
  }
  return [...calls.values()];
}

/**
 * The Usage record of each model call. `cost` is there only when the Provider or the gateway reported one, and
 * `gateway` names the log entry of Cloudflare AI Gateway.
 */
const usageOf = (events: ThreadEvent[]) =>
  events.flatMap((event) =>
    event.type === "usage.recorded" && event.kind === "model"
      ? [
          {
            seq: event.seq,
            profile: event.profile,
            provider: event.provider,
            model: event.model,
            input: event.input,
            output: event.output,
            ...(event.serverToolCalls !== undefined && { serverToolCalls: event.serverToolCalls }),
            ...(event.cost && { cost: event.cost }),
            ...(event.gateway && { gateway: event.gateway }),
          },
        ]
      : [],
  );

/**
 * Returns the Provider Tools that the Framework accepts on each profile. The Scope validates a Spec with the grant on
 * each profile, thus the page shows the rule of the Framework and not a copy of it. The profiles do not change while
 * the Worker runs, thus the answer is kept.
 */
function providerToolSupport(options: ProviderRouteOptions): () => Promise<Record<string, string[]>> {
  let support: Promise<Record<string, string[]>> | undefined;
  return () => {
    support ??= Promise.all(
      options.profiles.map(async (choice) => {
        const spec = providerDeskSpec(choice, { profile: choice.name, webSearch: true, policy: "none" });
        const result = await options.scope().agents.validate(spec);
        const unavailable = !result.ok && result.issues.some((issue) => issue.code === "capability.unavailable");
        return [choice.name, unavailable ? [] : [WEB_SEARCH]] as const;
      }),
    ).then(Object.fromEntries, (caught: unknown) => {
      support = undefined;
      throw caught;
    });
    return support;
  };
}

async function scenarioState(
  options: ProviderRouteOptions,
  support: () => Promise<Record<string, string[]>>,
): Promise<Response> {
  const stored = await storedSpec(options);
  const { thread } = await current(options);
  // The status call through the identity creates the Thread.
  const [status, events, tools] = await Promise.all([thread.status(), thread.events(), support()]);
  return Response.json({
    threadKey: thread.key,
    profiles: options.profiles.map((choice) => ({ ...choice, providerTools: tools[choice.name] ?? [] })),
    agent: stored ? { version: stored.version, spec: stored.spec, settings: settingsOf(stored.spec) } : null,
    steps: stepsOf(events),
    calls: callsOf(events),
    usage: usageOf(events),
    turn: { state: status.state, paused: status.paused },
  });
}

/**
 * Stores the settings of the page as the next version of the Agent Spec. The Thread stays, thus its next Turn runs
 * on the new profile with the earlier conversation. Returns an error answer for an unknown profile or a Spec that
 * does not pass validation.
 */
async function saveSettings(options: ProviderRouteOptions, body: unknown): Promise<Response | undefined> {
  const settings = decodeSettings(body);
  if (!settings)
    return routeError(
      400,
      "http.badRequest",
      'The body must be {"profile":"<name>","webSearch":true|false,"policy":"none"|"allow"|"deny"|"ask"}.',
    );
  const choice = options.profiles.find((entry) => entry.name === settings.profile);
  if (!choice)
    return routeError(400, "playground.profileUnknown", `Setup has no Provider profile "${settings.profile}".`);
  try {
    await options.scope().agents.put(providerDeskSpec(choice, settings));
    return undefined;
  } catch (caught) {
    return specRejected(caught);
  }
}

/** Cancels and deletes the Thread, moves to the next generation and stores the starting Spec again. */
async function reset(options: ProviderRouteOptions): Promise<void> {
  const { stub, thread } = await current(options);
  try {
    await thread.cancel();
    await thread.delete();
  } catch (caught) {
    // A reset that stopped after the delete leaves a deleted Thread. This reset then does the rest of the work.
    if (!(caught instanceof KarmiError) || caught.code !== "thread.deleted") throw caught;
  }
  await stub.reset();
  await storeStartingSpec(options);
}

/**
 * Creates the authenticated application routes of the Provider scenario. Its Agent Spec is stored in the sample Scope,
 * and a switch of the profile stores a new version for the same Thread.
 */
export function providerScenarioRoutes(options: ProviderRouteOptions) {
  const support = providerToolSupport(options);
  return {
    state: () => scenarioState(options, support),
    async reset() {
      await reset(options);
      return scenarioState(options, support);
    },
    async handle(request: Request, path: string): Promise<Response | undefined> {
      if (path !== `/api/scenarios/${PROVIDERS}/agent` || request.method !== "POST") return undefined;
      const body: unknown = await request.json().catch(() => undefined);
      return (await saveSettings(options, body)) ?? scenarioState(options, support);
    },
  };
}
