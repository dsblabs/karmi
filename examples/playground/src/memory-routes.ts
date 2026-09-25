import type { Scope, Thread } from "@karmi/core";
import { CONCIERGE, decodeMemoryData, MEMORY, PROFILE_FIELDS, type MemoryData } from "./concierge";
import { routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface MemoryRouteOptions {
  /** Opens one of the sample Scopes by id. */
  scope: (id: string) => Scope;
  /** The ids of the sample Scopes, in the order that the page shows them. The first one is the default. */
  scopeIds: readonly string[];
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
}

/** The one place that reads a body that names a sample Scope. */
function decodeScopeRequest(scopeIds: readonly string[], value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("scope" in value)) return undefined;
  return typeof value.scope === "string" && scopeIds.includes(value.scope) ? value.scope : undefined;
}

/** Opens the Thread with this number of the scenario in one Scope. The id names the Scope, thus no two Scopes share an id. */
const openThread = (scope: Scope, scopeId: string, user: string, generation: number, n: number): Thread =>
  scope.thread({ agent: CONCIERGE, user, threadId: `${CONCIERGE}-${scopeId}-${String(generation)}-${String(n)}` });

/** The Threads of the scenario in one Scope since the last reset, the current one last. */
function threadsOf(options: MemoryRouteOptions, scopeId: string, generation: number, data: MemoryData): Thread[] {
  const scope = options.scope(scopeId);
  return Array.from({ length: data.threads }, (_, index) =>
    openThread(scope, scopeId, options.user, generation, index + 1),
  );
}

async function scopeState(options: MemoryRouteOptions, scopeId: string) {
  const stored = await sampleData(options.data, scopeId, MEMORY).read();
  const data = decodeMemoryData(stored.data);
  const threads = threadsOf(options, scopeId, stored.generation, data);
  // The status call through the identity creates the Thread. The other reads need no sequence.
  const statuses = await Promise.all(threads.map((thread) => thread.status()));
  const users = options.scope(scopeId).users;
  const [memory, known] = await Promise.all([users.memory.get(options.user), users.memory.list()]);
  return {
    id: scopeId,
    // The current Thread is the last one. It is in `threads`, thus the page has its status too.
    threadKey: openThread(options.scope(scopeId), scopeId, options.user, stored.generation, data.threads).key,
    threads: threads.map((thread, index) => ({
      threadKey: thread.key,
      threadId: thread.identity.threadId,
      state: statuses[index]?.state ?? "idle",
    })),
    memory,
    users: known,
  };
}

async function scenarioState(options: MemoryRouteOptions): Promise<Response> {
  const scopes = await Promise.all(options.scopeIds.map((scopeId) => scopeState(options, scopeId)));
  return Response.json({ threadKey: scopes[0]?.threadKey ?? "", user: options.user, scopes, fields: PROFILE_FIELDS });
}

/** Opens the next Thread of the scenario in one Scope. The earlier Threads stay, thus the operator can compare them. */
async function startThread(options: MemoryRouteOptions, scopeId: string): Promise<Response> {
  const stub = sampleData(options.data, scopeId, MEMORY);
  const data = decodeMemoryData((await stub.read()).data);
  await stub.write(JSON.stringify({ threads: data.threads + 1 } satisfies MemoryData));
  return scenarioState(options);
}

/** Deletes the Profile and the Notes of the User in one Scope. The Threads stay. */
async function forget(options: MemoryRouteOptions, scopeId: string): Promise<Response> {
  await options.scope(scopeId).users.memory.delete(options.user);
  return scenarioState(options);
}

async function resetScope(options: MemoryRouteOptions, scopeId: string): Promise<void> {
  const stub = sampleData(options.data, scopeId, MEMORY);
  const stored = await stub.read();
  for (const thread of threadsOf(options, scopeId, stored.generation, decodeMemoryData(stored.data))) {
    // The cancel comes first: a running Turn could still write the Memory that the reset deletes.
    await thread.cancel();
    await thread.delete();
  }
  await options.scope(scopeId).users.memory.delete(options.user);
  await stub.reset();
}

async function resetScenario(options: MemoryRouteOptions): Promise<Response> {
  for (const scopeId of options.scopeIds) await resetScope(options, scopeId);
  return scenarioState(options);
}

async function handle(options: MemoryRouteOptions, request: Request, path: string): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined;
  const action =
    path === `/api/scenarios/${MEMORY}/thread`
      ? startThread
      : path === `/api/scenarios/${MEMORY}/forget`
        ? forget
        : undefined;
  if (!action) return undefined;
  const scopeId = decodeScopeRequest(options.scopeIds, await request.json().catch(() => undefined));
  if (!scopeId)
    return routeError(
      400,
      "http.badRequest",
      `The body must name a sample Scope in scope: ${options.scopeIds.join(" or ")}.`,
    );
  return action(options, scopeId);
}

/**
 * Creates the authenticated application routes of the Memory and Scope isolation scenario. The scenario runs in
 * each sample Scope, and its reset clears the Threads and the Memory of each one.
 */
export function memoryScenarioRoutes(options: MemoryRouteOptions) {
  return {
    state: () => scenarioState(options),
    reset: () => resetScenario(options),
    handle: (request: Request, path: string) => handle(options, request, path),
  };
}
