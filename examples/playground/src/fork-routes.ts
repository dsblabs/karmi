import type { Scope, Thread, ThreadEvent } from "@karmi/core";
import { decodeForkScenarioData, FORKS, referencedMedia, type ForkScenarioData } from "./media-forks";
import { mediaDownload } from "./media-download";
import { routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface ForkRouteOptions {
  scope: () => Scope;
  scopeId: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
  media: R2Bucket | undefined;
}

interface ForkRequest {
  seq: number;
}

function decodeForkRequest(value: unknown): ForkRequest | undefined {
  if (typeof value !== "object" || value === null || !("seq" in value)) return undefined;
  return typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq > 0 ? { seq: value.seq } : undefined;
}

interface ForkContext extends ForkRouteOptions {
  original(generation: number): Thread;
  fork(generation: number): Thread;
}

async function scenarioState(context: ForkContext): Promise<Response> {
  const stored = await sampleData(context.data, context.scopeId, FORKS).read();
  const scenario = decodeForkScenarioData(stored.data);
  const original = context.original(stored.generation);
  const originalEvents = scenario.state === "originalDeleted" ? [] : await original.events();
  const forked = scenario.state === "original" ? undefined : context.fork(stored.generation);
  const forkedEvents = forked ? await forked.events() : [];
  const view = async (thread: Thread, events: ThreadEvent[], deleted: boolean) => ({
    threadKey: thread.key,
    deleted,
    status: deleted ? { state: "deleted" } : await thread.status(),
    events,
    media: referencedMedia(events),
  });
  return Response.json({
    threadKey: original.key,
    original: await view(original, originalEvents, scenario.state === "originalDeleted"),
    fork: forked ? await view(forked, forkedEvents, false) : null,
    positions: originalEvents
      .filter((event) => event.type === "turn.completed")
      .map((event) => ({ seq: event.seq, label: `After Turn ${String(event.turn)}` })),
  });
}

async function createScenarioFork(context: ForkContext, request: Request): Promise<Response> {
  const body = decodeForkRequest(await request.json().catch(() => undefined));
  if (!body) return routeError(400, "http.badRequest", "The body must name a positive integer event position in seq.");
  const stub = sampleData(context.data, context.scopeId, FORKS);
  const stored = await stub.read();
  const scenario = decodeForkScenarioData(stored.data);
  if (scenario.state === "originalDeleted")
    return routeError(409, "playground.originalDeleted", "Reset the scenario before you fork a deleted Thread.");
  if (scenario.state === "forked")
    return routeError(409, "playground.forkExists", "This scenario already has a Fork. Reset it to make another one.");
  const original = context.original(stored.generation);
  const supported = (await original.events()).some(
    (event) => event.type === "turn.completed" && event.seq === body.seq,
  );
  if (!supported)
    return routeError(400, "playground.forkPosition", "Select the end of a completed Turn as the Fork position.");
  await original.fork(body.seq, { threadId: `${FORKS}-${String(stored.generation)}-fork` });
  await stub.write(JSON.stringify({ state: "forked", forkedAt: body.seq } satisfies ForkScenarioData));
  return scenarioState(context);
}

async function deleteOriginal(context: ForkContext): Promise<Response> {
  const stub = sampleData(context.data, context.scopeId, FORKS);
  const stored = await stub.read();
  const scenario = decodeForkScenarioData(stored.data);
  if (scenario.state === "original")
    return routeError(409, "playground.forkMissing", "Make a Fork before you delete the original Thread.");
  if (scenario.state === "forked") {
    await context.original(stored.generation).delete();
    await stub.write(
      JSON.stringify({ state: "originalDeleted", forkedAt: scenario.forkedAt } satisfies ForkScenarioData),
    );
  }
  return scenarioState(context);
}

async function download(context: ForkContext, threadKey: string, mediaId: string): Promise<Response> {
  if (!context.media) return routeError(503, "bindings.missing", "Media downloads need the KARMI_MEDIA bucket.");
  const stored = await sampleData(context.data, context.scopeId, FORKS).read();
  const scenario = decodeForkScenarioData(stored.data);
  const original = context.original(stored.generation);
  const forked = context.fork(stored.generation);
  const permitted =
    threadKey === original.key && scenario.state !== "originalDeleted"
      ? original
      : threadKey === forked.key && scenario.state !== "original"
        ? forked
        : undefined;
  if (!permitted) return routeError(404, "http.notFound", "No such media.");
  const ref = referencedMedia(await permitted.events()).find((entry) => entry.id === mediaId);
  return ref ? mediaDownload(context.media, ref) : routeError(404, "http.notFound", "No such media.");
}

async function resetScenario(context: ForkContext): Promise<Response> {
  const stub = sampleData(context.data, context.scopeId, FORKS);
  const stored = await stub.read();
  const scenario = decodeForkScenarioData(stored.data);
  if (scenario.state !== "originalDeleted") {
    await context.original(stored.generation).cancel();
    await context.original(stored.generation).delete();
  }
  if (scenario.state !== "original") {
    await context.fork(stored.generation).cancel();
    await context.fork(stored.generation).delete();
  }
  await stub.reset();
  return scenarioState(context);
}

/** Creates the authenticated application routes that guide one independent media Fork. */
export function forkScenarioRoutes(options: ForkRouteOptions) {
  const context: ForkContext = {
    ...options,
    original: (generation) =>
      options.scope().thread({ agent: FORKS, user: options.user, threadId: `${FORKS}-${String(generation)}` }),
    fork: (generation) =>
      options.scope().thread({ agent: FORKS, user: options.user, threadId: `${FORKS}-${String(generation)}-fork` }),
  };

  return {
    state: () => scenarioState(context),
    reset: () => resetScenario(context),
    agents: [FORKS],
    async handle(request: Request, path: string): Promise<Response | undefined> {
      const match = /^\/api\/scenarios\/forks\/threads\/([^/]+)\/media\/([^/]+)$/.exec(path);
      const threadKey = match?.[1];
      const mediaId = match?.[2];
      if (threadKey && mediaId && request.method === "GET") return download(context, threadKey, mediaId);
      if (path === "/api/scenarios/forks/fork" && request.method === "POST")
        return createScenarioFork(context, request);
      if (path === "/api/scenarios/forks/original/delete" && request.method === "POST") return deleteOriginal(context);
      return undefined;
    },
  };
}
