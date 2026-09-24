import { KarmiError, SpecInvalidError, type AgentSpec, type Karmi, type Scope, type Thread } from "@karmi/core";
import { createHttpHandler, type Principal } from "@karmi/http";
import { AGENTS, ASSISTANT } from "./assistant";
import { forkScenarioRoutes } from "./fork-routes";
import { FORKS } from "./media-forks";
import type { ProviderSetup } from "./provider-options";
import { SCHEDULES } from "./reminders";
import { routeError } from "./route-error";
import { CONCIERGE, MEMORY } from "./concierge";
import { knowledgeScenarioRoutes } from "./knowledge-routes";
import { KNOWLEDGE } from "./librarian";
import type { KeyringView } from "./keyring";
import { LIFECYCLE } from "./lifecycle";
import { lifecycleScenarioRoutes } from "./lifecycle-routes";
import { mcpScenarioRoutes } from "./mcp-routes";
import { memoryScenarioRoutes } from "./memory-routes";
import { OTHER_SCOPE, SAMPLE_SCOPES, scenarioRuntimes, SCOPE, USER, type Runtime } from "./runtimes";
import { sampleData, type SampleDataDO } from "./sample-data";
import { mediaDownload } from "./media-download";
import { MCP, type OAuthSetup } from "./remote-mcp";
import { COVERAGE, SCENARIOS, viewScenario, type Services } from "./scenarios";
import { scheduleScenarioRoutes, triggerSupplierDelivery } from "./schedule-routes";

export { CONCIERGE, KNOWLEDGE, MEMORY, OTHER_SCOPE, SCOPE, USER };

/** What `createPlayground` needs. The tests give it a karmi with a scripted Provider. */
export interface PlaygroundOptions extends Services {
  karmi: Karmi;
  /** The model id of the Agents, in the form `provider/model`. The Catalogue must use the same one. */
  model: string;
  /** The Provider selection of setup, or undefined when setup did not run. */
  setup: ProviderSetup | undefined;
  /** The operator access token. Without it, each request gets a 401 answer. */
  token: string | undefined;
  /** The namespace of the sample systems. */
  data: DurableObjectNamespace<SampleDataDO>;
  /** The media bucket used by the authenticated download route. */
  media: R2Bucket | undefined;
  /** The ids of the `KARMI_KEYRING` keys, which the Scope lifecycle scenario shows. Undefined without a key ring. */
  keyring: KeyringView | undefined;
  /**
   * The public origin of the Worker, which the OAuth Connections of the MCP scenario need, or why they are not
   * available. The karmi must have the same origin in `createKarmi({ oauth })`.
   */
  oauth: OAuthSetup;
}

/** The Playground as a Worker `fetch`. */
export interface Playground {
  /** Answers the Thread routes and the routes below `/api`. Returns a 404 answer for each other path. */
  fetch(request: Request, env?: unknown, ctx?: ExecutionContext): Promise<Response>;
  /**
   * Sends the supplier Event of the Schedules scenario, as a Worker `scheduled` handler does for a cron trigger.
   * `at` is the scheduled time in epoch milliseconds.
   */
  supplierDelivery(at: number): Promise<void>;
}

/** The routes of a scenario that does not use the shared state and reset routes. */
interface ScenarioRoutes {
  state(): Promise<Response>;
  reset(): Promise<Response>;
  /** Answers a route of the scenario, or returns undefined for each other path. */
  handle(request: Request, path: string): Promise<Response | undefined>;
}

/** Answers a route of a scenario that has its own routes, or returns undefined for each other path. */
async function ownRoutes(
  own: Record<string, ScenarioRoutes>,
  request: Request,
  path: string,
): Promise<Response | undefined> {
  const [, id, action] = /^\/api\/scenarios\/([^/]+)(\/reset)?$/.exec(path) ?? [];
  const named = id === undefined ? undefined : own[id];
  if (named && action === undefined && request.method === "GET") return named.state();
  if (named && action !== undefined && request.method === "POST") return named.reset();
  for (const routes of Object.values(own)) {
    const response = await routes.handle(request, path);
    if (response) return response;
  }
  return undefined;
}

const encoder = new TextEncoder();

async function sameToken(given: string, expected: string): Promise<boolean> {
  // The digests have the same length, which the constant-time comparison needs.
  const [a, b] = await Promise.all(
    [given, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return a !== undefined && b !== undefined && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Maps a request to its Principal. The token opens the sample Scopes only: the two fixed ones, and the current
 * disposable Scopes of the Scope lifecycle and MCP scenarios, which `opens` checks. The `scope` query parameter
 * selects one of them for the Thread routes, and a request without it acts in the first one.
 */
function authentication(token: string | undefined, opens: (scope: string) => Promise<boolean>) {
  return async (request: Request): Promise<Principal | null> => {
    const query = new URL(request.url).searchParams;
    const header = request.headers.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : query.get("token");
    const scope = query.get("scope") ?? SCOPE;
    if (!SAMPLE_SCOPES.includes(scope) && !(await opens(scope))) return null;
    return token && given && (await sameToken(given, token)) ? { scope, user: USER } : null;
  };
}

// The one place that reads the body of the Spec route. It checks only the Agent id, because `put` validates each other
// part of the Spec and reports the issues. The schema output of the Framework is not assignable to `AgentSpec`.
function decodeSpec(body: unknown): AgentSpec | undefined {
  const named = typeof body === "object" && body !== null && "agentId" in body && body.agentId === ASSISTANT;
  return named ? (body as AgentSpec) : undefined;
}

/**
 * Stores the body as the next version of the Agent Spec of the scenario. Returns an error answer when the body is
 * not JSON, names a different Agent or does not pass validation. Returns nothing after a successful store.
 */
async function putSpec(scope: Scope, request: Request): Promise<Response | undefined> {
  // The editor must not replace the Agent of a different scenario, which a reset of this scenario cannot restore.
  const spec = decodeSpec(await request.json().catch(() => undefined));
  if (!spec)
    return routeError(400, "http.badRequest", `The body must be a JSON Agent Spec with the agentId "${ASSISTANT}".`);
  try {
    await scope.agents.put(spec);
    return undefined;
  } catch (caught) {
    if (!(caught instanceof SpecInvalidError)) throw caught;
    const { code, message, result } = caught;
    return Response.json({ error: { code, message, issues: result.issues } }, { status: 422 });
  }
}

/**
 * Ends the Thread of a scenario and its child Threads, and resets its sample data. The next generation gets a
 * new Thread. `restore` then restores what the scenario stores outside its sample data, when given.
 */
async function resetScenario(
  stub: DurableObjectStub<SampleDataDO>,
  thread: Thread,
  runtime: Runtime,
  restore: boolean,
): Promise<void> {
  // The order matters: the cancel stops a Turn that could still change the data which the reset restores. It also
  // cancels each child Thread. A delete does not reach a child, thus the reset deletes each one.
  try {
    await thread.cancel();
    for (const child of (await runtime.children?.(thread)) ?? []) await child.delete();
    await thread.delete();
  } catch (caught) {
    // A reset that stopped after the delete leaves a deleted Thread. This reset then does the rest of the work.
    if (!(caught instanceof KarmiError) || caught.code !== "thread.deleted") throw caught;
  }
  await stub.reset();
  if (restore) await runtime.restore?.();
}

/** The sample Scope, the User and the sample systems that the routes of a scenario work with. */
interface SampleOptions {
  scope: () => Scope;
  scopeId: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
}

/**
 * Returns the routes of each scenario that has its own state, reset and routes, by scenario id. These are the
 * scenarios with more than one Thread, or with state outside their sample data.
 */
function ownScenarioRoutes(karmi: Karmi, sample: SampleOptions, options: PlaygroundOptions) {
  const { user, data } = sample;
  const { media, model, setup, keyring, oauth } = options;
  const mcp = mcpScenarioRoutes({ scope: (id) => karmi.scope(id), home: SCOPE, user, data, model, oauth });
  return {
    [FORKS]: forkScenarioRoutes({ ...sample, media }),
    [SCHEDULES]: scheduleScenarioRoutes(sample),
    [MEMORY]: memoryScenarioRoutes({ scope: (id) => karmi.scope(id), scopeIds: SAMPLE_SCOPES, user, data }),
    [KNOWLEDGE]: knowledgeScenarioRoutes(sample),
    [LIFECYCLE]: lifecycleScenarioRoutes({
      scope: (id) => karmi.scope(id),
      home: SCOPE,
      otherScopes: async () => [...SAMPLE_SCOPES, await mcp.scopeId()],
      user,
      data,
      model,
      baseUrl: setup?.baseUrl,
      keyring,
    }),
    [MCP]: mcp,
  } satisfies Record<string, ScenarioRoutes>;
}

/**
 * Answers with one downloadable media file of the current Thread of a scenario. A file of a Thread before a reset is
 * gone, thus it gets a 404 answer.
 */
async function downloadMedia(
  runtime: Runtime,
  stub: DurableObjectStub<SampleDataDO>,
  open: (generation: number) => Thread,
  media: R2Bucket | undefined,
  mediaId: string,
): Promise<Response> {
  if (!runtime.media) return routeError(404, "http.notFound", "No such route.");
  if (!media) return routeError(503, "bindings.missing", "Media downloads need the KARMI_MEDIA bucket.");
  const state = await stub.read();
  const ref = (await runtime.media(state.data, open(state.generation))).find((entry) => entry.id === mediaId);
  return ref ? mediaDownload(media, ref) : routeError(404, "http.notFound", "No such media.");
}

/** The answer of `/api/playground`: the selected Provider without its credential, the scenarios and the coverage. */
function describePlayground(setup: ProviderSetup | undefined, services: Services): Response {
  return Response.json({
    provider: setup
      ? { id: setup.option.id, label: setup.option.label, model: setup.model, baseUrl: setup.baseUrl }
      : null,
    scenarios: SCENARIOS.map((scenario) => viewScenario(scenario, setup, services)),
    coverage: COVERAGE,
  });
}

/**
 * Creates the Playground routes on a karmi. The access token guards each route: the Thread routes of
 * `@karmi/http` and the routes below `/api`. No route returns a credential.
 */
export function createPlayground(options: PlaygroundOptions): Playground {
  const { karmi, model, setup, token, data, media } = options;
  // `karmi.scope` makes random values, which the Workers runtime allows only while it handles a request.
  const scope = () => karmi.scope(SCOPE);

  const runtimes = scenarioRuntimes(scope, model);
  const sample: SampleOptions = { scope, scopeId: SCOPE, user: USER, data };
  const own = ownScenarioRoutes(karmi, sample, options);

  // A browser cannot set headers on an EventSource, so the token can also be a query parameter.
  const authenticate = authentication(
    token,
    async (scopeId) => (await own[LIFECYCLE].opens(scopeId)) || own[MCP].opens(scopeId),
  );
  const http = createHttpHandler({ karmi, authenticate });

  const threadOf = (runtime: Runtime, generation: number) =>
    scope().thread({ agent: runtime.agent, user: USER, threadId: `${runtime.agent}-${generation}` });

  async function scenarioState(id: string, runtime: Runtime): Promise<Response> {
    await runtime.prepare?.();
    const state = await sampleData(data, SCOPE, id).read();
    const thread = threadOf(runtime, state.generation);
    // A key opens a Thread but never creates it. The status call through the identity creates the Thread.
    const status = await thread.status();
    return Response.json({ ...(await runtime.view(state.data, status, thread)), threadKey: thread.key });
  }

  async function api(request: Request, path: string): Promise<Response> {
    if (path === "/api/playground" && request.method === "GET") return describePlayground(setup, options);
    const answered = await ownRoutes(own, request, path);
    if (answered) return answered;
    const [, id, action, mediaId] =
      /^\/api\/scenarios\/([^/]+)(?:\/(reset|spec|job|hold|fail|replay|redact|media\/([^/]+)))?$/.exec(path) ?? [];
    const runtime = id === undefined ? undefined : runtimes[id];
    if (id === undefined || !runtime) return routeError(404, "http.notFound", "No such route.");
    if (action === undefined && request.method === "GET") return scenarioState(id, runtime);
    const open = (generation: number) => threadOf(runtime, generation);
    if (mediaId !== undefined && request.method === "GET")
      return downloadMedia(runtime, sampleData(data, SCOPE, id), open, media, mediaId);
    const restart = async (restore: boolean) => {
      const stub = sampleData(data, SCOPE, id);
      const thread = threadOf(runtime, (await stub.read()).generation);
      await resetScenario(stub, thread, runtime, restore);
      return scenarioState(id, runtime);
    };
    if (action === "reset" && request.method === "POST") return restart(true);
    const act = action === undefined ? undefined : runtime.actions?.[action];
    if (act && request.method === "POST")
      return (await act(sampleData(data, SCOPE, id), open, request)) ?? scenarioState(id, runtime);
    // A saved Spec starts a new Thread, thus the earlier answers cannot change what the new version does.
    if (action === "spec" && id === AGENTS && request.method === "PUT")
      return (await putSpec(scope(), request)) ?? restart(false);
    return routeError(404, "http.notFound", "No such route.");
  }

  return {
    supplierDelivery: (at) => triggerSupplierDelivery(sample, "The scheduled handler of the Worker", at),
    async fetch(request, _env, ctx) {
      const path = new URL(request.url).pathname;
      // The client document and the OAuth callback need no token: the authorization server and the browser of the
      // operator call them, and the callback checks the state of its pending authorization.
      const oauth = await karmi.oauth.handle(request);
      if (oauth) return oauth;
      if (!path.startsWith("/api/")) return http.fetch(request, _env, ctx);
      if (!(await authenticate(request))) return routeError(401, "http.unauthorized", "Authentication required.");
      return api(request, path);
    },
  };
}
