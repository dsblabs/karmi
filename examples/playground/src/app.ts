import type { Karmi } from "@karmi/core";
import { createHttpHandler, type Principal } from "@karmi/http";
import { PROVIDER_OPTIONS, type ProviderSetup } from "./provider-options";
import { decodeOrder, REFUND } from "./refund";
import { sampleData, type SampleDataDO } from "./sample-data";
import { COVERAGE, SCENARIOS, viewScenario } from "./scenarios";

/** The first sample Scope. Each scenario of this slice runs in it. */
export const SCOPE = "sample-a";
/** The User of the one operator. */
export const USER = "operator";

/** What `createPlayground` needs. The tests give it a karmi with a scripted Provider. */
export interface PlaygroundOptions {
  karmi: Karmi;
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

/**
 * Creates the Playground routes on a karmi. The access token guards each route: the Thread routes of
 * `@karmi/http` and the routes below `/api`. No route returns a credential.
 */
export function createPlayground({ karmi, setup, token, data }: PlaygroundOptions): Playground {
  // A browser cannot set headers on an EventSource, so the token can also be a query parameter.
  const authenticate = async (request: Request): Promise<Principal | null> => {
    const header = request.headers.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
    return token && given && (await sameToken(given, token)) ? { scope: SCOPE, user: USER } : null;
  };
  const http = createHttpHandler({ karmi, authenticate });

  // `karmi.scope` makes random values, which the Workers runtime allows only while it handles a request.
  const refundThread = (generation: number) =>
    karmi.scope(SCOPE).thread({ agent: REFUND, user: USER, threadId: `${REFUND}-${generation}` });

  async function refundState(): Promise<Response> {
    const state = await sampleData(data, SCOPE, REFUND).read();
    const thread = refundThread(state.generation);
    // A key opens a Thread but never creates it. The status call through the identity creates the Thread.
    await thread.status();
    return Response.json({ order: decodeOrder(state.data), threadKey: thread.key });
  }

  async function api(request: Request, path: string): Promise<Response> {
    if (path === "/api/playground" && request.method === "GET")
      return Response.json({
        provider: setup
          ? { id: setup.option.id, label: setup.option.label, model: setup.model, baseUrl: setup.baseUrl }
          : null,
        providers: PROVIDER_OPTIONS.map((option) => option.label),
        scenarios: SCENARIOS.map((scenario) => viewScenario(scenario, setup)),
        coverage: COVERAGE,
      });
    if (path === `/api/scenarios/${REFUND}` && request.method === "GET") return refundState();
    if (path === `/api/scenarios/${REFUND}/reset` && request.method === "POST") {
      const stub = sampleData(data, SCOPE, REFUND);
      const thread = refundThread((await stub.read()).generation);
      // The order matters: the cancel stops a Turn that could still change the data which the reset restores.
      await thread.cancel();
      await thread.delete();
      await stub.reset();
      return refundState();
    }
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
