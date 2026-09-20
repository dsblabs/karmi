import { SpecInvalidError, type AgentSpec, type Karmi, type Scope } from "@karmi/core";
import { createHttpHandler, type Principal } from "@karmi/http";
import { AGENTS, ASSISTANT } from "./assistant";
import type { ProviderSetup } from "./provider-options";
import { scenarioRuntimes, SCOPE, USER, type Runtime } from "./runtimes";
import { sampleData, type SampleDataDO } from "./sample-data";
import { COVERAGE, SCENARIOS, viewScenario } from "./scenarios";

export { SCOPE, USER };

/** What `createPlayground` needs. The tests give it a karmi with a scripted Provider. */
export interface PlaygroundOptions {
  karmi: Karmi;
  /** The model id of the Agents, in the form `provider/model`. The Catalogue must use the same one. */
  model: string;
  /** The Provider selection of setup, or undefined when setup did not run. */
  setup: ProviderSetup | undefined;
  /** The operator access token. Without it, each request gets a 401 answer. */
  token: string | undefined;
  /** The namespace of the sample systems. */
  data: DurableObjectNamespace<SampleDataDO>;
}

/** The Playground as a Worker `fetch`. */
export interface Playground {
  /** Answers the Thread routes and the routes below `/api`. Returns a 404 answer for each other path. */
  fetch(request: Request, env?: unknown, ctx?: ExecutionContext): Promise<Response>;
}

const encoder = new TextEncoder();

async function sameToken(given: string, expected: string): Promise<boolean> {
  // The digests have the same length, which the constant-time comparison needs.
  const [a, b] = await Promise.all(
    [given, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return a !== undefined && b !== undefined && crypto.subtle.timingSafeEqual(a, b);
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
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
    return error(400, "http.badRequest", `The body must be a JSON Agent Spec with the agentId "${ASSISTANT}".`);
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
 * Creates the Playground routes on a karmi. The access token guards each route: the Thread routes of
 * `@karmi/http` and the routes below `/api`. No route returns a credential.
 */
export function createPlayground({ karmi, model, setup, token, data }: PlaygroundOptions): Playground {
  // A browser cannot set headers on an EventSource, so the token can also be a query parameter.
  const authenticate = async (request: Request): Promise<Principal | null> => {
    const header = request.headers.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
    return token && given && (await sameToken(given, token)) ? { scope: SCOPE, user: USER } : null;
  };
  const http = createHttpHandler({ karmi, authenticate });

  // `karmi.scope` makes random values, which the Workers runtime allows only while it handles a request.
  const scope = () => karmi.scope(SCOPE);

  const runtimes = scenarioRuntimes(scope, model);

  const threadOf = (runtime: Runtime, generation: number) =>
    scope().thread({ agent: runtime.agent, user: USER, threadId: `${runtime.agent}-${generation}` });

  async function scenarioState(id: string, runtime: Runtime): Promise<Response> {
    await runtime.prepare?.();
    const state = await sampleData(data, SCOPE, id).read();
    const thread = threadOf(runtime, state.generation);
    // A key opens a Thread but never creates it. The status call through the identity creates the Thread.
    await thread.status();
    return Response.json({ ...(await runtime.view(state.data)), threadKey: thread.key });
  }

  async function api(request: Request, path: string): Promise<Response> {
    if (path === "/api/playground" && request.method === "GET")
      return Response.json({
        provider: setup
          ? { id: setup.option.id, label: setup.option.label, model: setup.model, baseUrl: setup.baseUrl }
          : null,
        scenarios: SCENARIOS.map((scenario) => viewScenario(scenario, setup)),
        coverage: COVERAGE,
      });
    const [, id, action] = /^\/api\/scenarios\/([^/]+)(?:\/(reset|spec))?$/.exec(path) ?? [];
    const runtime = id === undefined ? undefined : runtimes[id];
    if (id === undefined || !runtime) return error(404, "http.notFound", "No such route.");
    if (action === undefined && request.method === "GET") return scenarioState(id, runtime);
    const restart = async (restore: boolean) => {
      const stub = sampleData(data, SCOPE, id);
      const thread = threadOf(runtime, (await stub.read()).generation);
      // The order matters: the cancel stops a Turn that could still change the data which the reset restores.
      await thread.cancel();
      await thread.delete();
      await stub.reset();
      if (restore) await runtime.restore?.();
      return scenarioState(id, runtime);
    };
    if (action === "reset" && request.method === "POST") return restart(true);
    // A saved Spec starts a new Thread, thus the earlier answers cannot change what the new version does.
    if (action === "spec" && id === AGENTS && request.method === "PUT")
      return (await putSpec(scope(), request)) ?? restart(false);
    return error(404, "http.notFound", "No such route.");
  }

  return {
    async fetch(request, _env, ctx) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/api/")) return http.fetch(request, _env, ctx);
      if (!(await authenticate(request))) return error(401, "http.unauthorized", "Authentication required.");
      return api(request, path);
    },
  };
}
