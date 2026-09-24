import { KarmiError, type Scope, type ScopeState, type Thread, type ThreadEvent } from "@karmi/core";
import type { KeyringView } from "./keyring";
import {
  CREDENTIAL,
  decodeLifecycle,
  disposableScope,
  LIFECYCLE,
  lifecycleConfig,
  PROFILE,
  SCOPE_DESK,
  type LifecycleData,
} from "./lifecycle";
import { conflictOf, routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface LifecycleRouteOptions {
  /** Opens a Scope by id. */
  scope: (id: string) => Scope;
  /** The Scope that holds the sample data of the scenario. It is not the disposable Scope. */
  home: string;
  /** Returns the Scopes of the other scenarios. A rewrap covers them too. */
  otherScopes: () => Promise<readonly string[]>;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
  /** The model id of the Agents, in the form `provider/model`. Its prefix is the adapter of the Scope profile. */
  model: string;
  /** The endpoint of a custom Provider, from setup. */
  baseUrl: string | undefined;
  /** The ids of the `KARMI_KEYRING` keys, or undefined when the Worker has no key ring. */
  keyring: KeyringView | undefined;
}

/** The longest credential that the route accepts. A Provider key is much shorter. */
const MAX_CREDENTIAL = 4096;

/** Returns the credential in the body of the credential route, or undefined when the body has none. */
function decodeCredential(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("value" in body) || typeof body.value !== "string")
    return undefined;
  const value = body.value.trim();
  return value.length > 0 && value.length <= MAX_CREDENTIAL ? value : undefined;
}

/** Returns the `on` value in the body of the fallback route, or undefined when the body has none. */
function decodeFallback(body: unknown): boolean | undefined {
  if (typeof body !== "object" || body === null || !("on" in body)) return undefined;
  return typeof body.on === "boolean" ? body.on : undefined;
}

/** True while the Scope holds its data: before a destroy. */
const isLive = (state: ScopeState): boolean => state === "active" || state === "suspended";

/** The current generation of the scenario: its disposable Scope, its Thread and its sample data. */
interface Current {
  stub: DurableObjectStub<SampleDataDO>;
  data: LifecycleData;
  scopeId: string;
  scope: Scope;
  thread: Thread;
}

async function current(options: LifecycleRouteOptions): Promise<Current> {
  const stub = sampleData(options.data, options.home, LIFECYCLE);
  const stored = await stub.read();
  const scopeId = disposableScope(stored.generation);
  const scope = options.scope(scopeId);
  const thread = scope.thread({ agent: SCOPE_DESK, user: options.user, threadId: SCOPE_DESK });
  return { stub, data: decodeLifecycle(stored.data), scopeId, scope, thread };
}

/** What each model Step of the Thread ran under: its profile, its credential version and a fallback. */
function stepsOf(events: ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "step.started" && event.kind === "model"
      ? [
          {
            seq: event.seq,
            turn: event.turn,
            profile: event.profile,
            ...(event.credential && { credential: event.credential }),
            ...(event.fallback && { fallback: event.fallback }),
          },
        ]
      : [],
  );
}

async function scenarioState(options: LifecycleRouteOptions): Promise<Response> {
  const { data, scopeId, scope, thread } = await current(options);
  let status = await scope.status();
  // A new disposable Scope gets the profile of the scenario. The page reads the state before its first Turn. Two
  // reads at the same time write the config once, because the write is a compare-and-set.
  if (status.state === "active" && status.configRevision === 0) {
    await scope.config
      .set(lifecycleConfig(options.model, options.baseUrl, true), { ifRevision: 0 })
      .catch((caught: unknown) => conflictOf(caught, "config.conflict"));
    status = await scope.status();
  }
  // A destroyed Scope refuses each read other than its status. Its Thread and its credential are gone.
  const live = isLive(status.state);
  const [destroy, config, credential, turn, events] = await Promise.all([
    data.operationId === undefined ? null : scope.destroyStatus(data.operationId),
    live ? scope.config.get() : null,
    live ? scope.credentials.describe(CREDENTIAL) : undefined,
    // The status call through the identity creates the Thread.
    live ? thread.status() : null,
    live ? thread.events() : [],
  ]);
  const profile = config?.document.providers?.[PROFILE] ?? null;
  return Response.json({
    threadKey: thread.key,
    scopeId,
    scope: { id: scopeId, ...status },
    destroy,
    profile,
    fallback: profile?.fallback !== undefined,
    reference: `scope:${CREDENTIAL}`,
    credential: credential ?? null,
    test: data.test ?? null,
    keyring: options.keyring ?? null,
    rewrap: data.rewrap ?? null,
    steps: stepsOf(events),
    turn: turn && { state: turn.state, paused: turn.paused },
  });
}

/** Stores one field of the sample data of the current generation. */
const remember = <Field extends keyof LifecycleData>(now: Current, field: Field, value: LifecycleData[Field]) =>
  now.stub.set(field, JSON.stringify(value));

/**
 * Resumes the Scope. A Turn that parked while the Scope was suspended waits for `thread.resume`, thus the route
 * also resumes the Thread when it is parked for that reason.
 */
async function resume(now: Current): Promise<void> {
  await now.scope.resume();
  if ((await now.thread.status()).paused === "scope_suspended") await now.thread.resume();
}

/** Tombstones the disposable Scope and keeps the operation id, thus the page can follow the Destroy walk. */
async function destroy(now: Current): Promise<void> {
  const { operationId } = await now.scope.destroy();
  await remember(now, "operationId", operationId);
}

/** Tests the Scope profile with one small call to the Provider and keeps the answer without the Provider details. */
async function test(now: Current, model: string): Promise<void> {
  const result = await now.scope.providers.test(PROFILE, { model });
  await remember(now, "test", {
    ok: result.ok,
    at: Date.now(),
    ...(result.ok
      ? result.credential && { credential: result.credential }
      : { error: { code: result.error.code, message: result.error.message } }),
  });
}

/**
 * Rewraps the credentials of each Scope that the Playground uses: the disposable Scope and the Scopes of the other
 * scenarios. A destroyed disposable Scope has no credential, thus the rewrap skips it and still covers the others.
 */
async function rewrap(options: LifecycleRouteOptions, now: Current): Promise<void> {
  const counts: Record<string, number> = {};
  const live = isLive((await now.scope.status()).state);
  for (const id of [...(live ? [now.scopeId] : []), ...(await options.otherScopes())])
    counts[id] = (await options.scope(id).credentials.rewrap()).rewrapped;
  await remember(now, "rewrap", counts);
}

/**
 * Destroys the disposable Scope, when it still exists, and moves to the next generation. The next generation has
 * a new Scope id, because a destroyed id stays reserved. The Provider credential of setup is not in a Scope.
 */
async function reset(options: LifecycleRouteOptions): Promise<Response> {
  const now = await current(options);
  if (isLive((await now.scope.status()).state)) {
    // The cancel stops a Turn at once. The Destroy walk then deletes the Thread with the rest of the Scope.
    await now.thread.cancel().catch((caught: unknown) => {
      if (!(caught instanceof KarmiError)) throw caught;
    });
    await now.scope.destroy();
  }
  await now.stub.reset();
  return scenarioState(options);
}

/** One action of the scenario. It returns an error answer, or nothing when the route answers with the state. */
type Action = (options: LifecycleRouteOptions, now: Current, body: unknown) => Promise<Response | void>;

const ACTIONS: Record<string, Action> = {
  suspend: (_options, now) => now.scope.suspend(),
  resume: (_options, now) => resume(now),
  destroy: (_options, now) => destroy(now),
  credential: async (_options, now, body) => {
    const value = decodeCredential(body);
    if (value === undefined)
      return routeError(
        400,
        "http.badRequest",
        `The body must be {"value":"..."} with 1 to ${MAX_CREDENTIAL} characters.`,
      );
    // The route answers with the metadata of the scenario state only. No route reads the value back.
    await now.scope.credentials.put(CREDENTIAL, value);
  },
  test: (options, now) => test(now, options.model),
  revoke: (_options, now) => now.scope.credentials.revoke(CREDENTIAL),
  fallback: async (options, now, body) => {
    const on = decodeFallback(body);
    if (on === undefined) return routeError(400, "http.badRequest", 'The body must be {"on":true} or {"on":false}.');
    await now.scope.config.set(lifecycleConfig(options.model, options.baseUrl, on));
  },
  rewrap: (options, now) => rewrap(options, now),
};

async function handle(options: LifecycleRouteOptions, request: Request, path: string): Promise<Response | undefined> {
  const [, name] = new RegExp(`^/api/scenarios/${LIFECYCLE}/([a-z]+)$`).exec(path) ?? [];
  const action = name === undefined ? undefined : ACTIONS[name];
  if (!action || request.method !== "POST") return undefined;
  const body: unknown = await request.json().catch(() => undefined);
  try {
    const answer = await action(options, await current(options), body);
    return answer instanceof Response ? answer : await scenarioState(options);
  } catch (caught) {
    // A destroyed Scope refuses each operation, and a key ring without the key of a credential cannot open it. The
    // page shows the code and the message of the Framework.
    return conflictOf(caught, "");
  }
}

/**
 * Creates the authenticated application routes of the Scope lifecycle and credentials scenario. The scenario runs
 * in a disposable Scope. A reset destroys it and moves to a new Scope id.
 */
export function lifecycleScenarioRoutes(options: LifecycleRouteOptions) {
  return {
    /** True when `scopeId` is the current disposable Scope. The access token opens no other one. */
    opens: async (scopeId: string) => (await current(options)).scopeId === scopeId,
    state: () => scenarioState(options),
    reset: () => reset(options),
    handle: (request: Request, path: string) => handle(options, request, path),
  };
}
