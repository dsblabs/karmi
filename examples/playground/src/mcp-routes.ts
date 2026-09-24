import { KarmiError, type McpSnapshot, type Scope, type Thread } from "@karmi/core";
import {
  decodeMcpData,
  decodeRegistration,
  MCP,
  MCP_DESK,
  mcpConfig,
  mcpDeskAgent,
  mcpDeskSpec,
  mcpScope,
  CONNECTION,
  SERVER,
  STATIC_CREDENTIAL,
  STATIC_REFERENCE,
  type McpData,
  type OAuthSetup,
} from "./remote-mcp";
import { conflictOf, routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface McpRouteOptions {
  /** Opens a Scope by id. */
  scope: (id: string) => Scope;
  /** The Scope that holds the sample data of the scenario. It is not the disposable Scope. */
  home: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
  /** The model id of the Agents. The page shows the Permission Policy of the Agent for it. */
  model: string;
  /** The public origin of the Worker for OAuth, or why OAuth is not available. */
  oauth: OAuthSetup;
}

/** The current generation of the scenario: its disposable Scope, its Thread and its sample data. */
interface Current {
  stub: DurableObjectStub<SampleDataDO>;
  data: McpData;
  scopeId: string;
  scope: Scope;
  thread: Thread;
}

async function current(options: McpRouteOptions): Promise<Current> {
  const stub = sampleData(options.data, options.home, MCP);
  const stored = await stub.read();
  const scopeId = mcpScope(stored.generation);
  const scope = options.scope(scopeId);
  const thread = scope.thread({ agent: MCP_DESK, user: options.user, threadId: MCP_DESK });
  return { stub, data: decodeMcpData(stored.data), scopeId, scope, thread };
}

/**
 * The registered server as a Turn of the User takes it: its cached tool list and the credential reference that did
 * not resolve. The snapshot does not contact the server. The page gets no header value and no token from it. A
 * snapshot that failed, for example for an OAuth server after the origin was removed, gives its error.
 */
function serverView(snapshot: McpSnapshot | KarmiError | undefined) {
  if (snapshot instanceof KarmiError)
    return { missing: null, catalog: null, unavailable: { code: snapshot.code, message: snapshot.message } };
  const server = snapshot?.servers[0];
  const catalog = server?.catalog;
  return {
    missing: server?.missing ?? null,
    catalog: catalog
      ? {
          version: catalog.catalogVersion,
          fetchedAt: catalog.fetchedAt,
          ttlMs: catalog.ttlMs,
          cacheScope: catalog.cacheScope,
          // The discover answer of a modern server is large. The page names the protocol era only.
          era: catalog.era.kind,
          tools: catalog.tools.map(({ name, description, annotations }) => ({ name, description, annotations })),
        }
      : null,
    unavailable: null,
  };
}

async function scenarioState(options: McpRouteOptions): Promise<Response> {
  const { data, scopeId, scope, thread } = await current(options);
  const config = await scope.config.get();
  const server = config.document.mcp?.servers?.[SERVER] ?? null;
  const auth = server?.auth?.type ?? "none";
  const [snapshot, credential, connections, turn] = await Promise.all([
    server
      ? scope.mcp.snapshot({ agent: MCP_DESK, user: options.user, serverIds: [SERVER] }).catch((caught: unknown) => {
          // The page must still show the state, because Reset scenario is the way out.
          if (!(caught instanceof KarmiError)) throw caught;
          return caught;
        })
      : undefined,
    auth === "static" ? scope.credentials.describe(STATIC_CREDENTIAL) : undefined,
    auth === "oauth" ? scope.users.connections.list(options.user) : [],
    // The status call through the identity creates the Thread.
    thread.status(),
  ]);
  return Response.json({
    threadKey: thread.key,
    scopeId,
    oauth: "origin" in options.oauth ? { available: true } : { available: false, reason: options.oauth.reason },
    server: server && { id: SERVER, config: server, hosts: config.document.egress?.mcpHosts ?? [] },
    ...serverView(snapshot),
    credential: credential ? { reference: STATIC_REFERENCE, ...credential } : null,
    user: options.user,
    connectionName: CONNECTION,
    connection: connections.find((entry) => entry.name === CONNECTION) ?? null,
    discovery: data.discovery ?? null,
    policy: mcpDeskAgent(options.model).spec.policy,
    turn: { state: turn.state, paused: turn.paused },
  });
}

/** Refreshes the tool list of the server for the User and keeps the outcome. A failure is a result, not an error. */
async function discover(options: McpRouteOptions, now: Current): Promise<void> {
  let discovery: McpData["discovery"];
  try {
    await now.scope.mcp.refreshCatalog(SERVER, { agent: MCP_DESK, user: options.user });
    discovery = { ok: true, at: Date.now() };
  } catch (caught) {
    if (!(caught instanceof KarmiError)) throw caught;
    discovery = { ok: false, at: Date.now(), error: { code: caught.code, message: caught.message } };
  }
  await now.stub.set("discovery", JSON.stringify(discovery));
}

/**
 * Registers the server of the body in the disposable Scope, gives its Tools to the Agent, then lists them. A static
 * header value goes to the credential store first, thus the config names a credential that exists. Returns an error
 * answer when the body is not a registration, when the Scope has a server, or when the Scope config refuses the server.
 */
async function register(options: McpRouteOptions, now: Current, body: unknown): Promise<Response | undefined> {
  const registration = decodeRegistration(body);
  if (!registration)
    return routeError(
      400,
      "http.badRequest",
      'The body must be {"url":"https://...","auth":"none"|"static"|"oauth","trustAnnotations":false}. A static server also needs "header" and "value".',
    );
  if (registration.auth === "oauth" && "reason" in options.oauth)
    return routeError(409, "playground.oauthUnavailable", options.oauth.reason);
  // A second registration with the same server id could use the tool list or the grant of the first server. Thus
  // the scenario registers one server for each disposable Scope, and a reset gives a new Scope.
  if ((await now.scope.config.get()).revision > 0)
    return routeError(409, "playground.serverRegistered", "A server is registered. Reset the scenario to change it.");
  if (registration.auth === "static") await now.scope.credentials.put(STATIC_CREDENTIAL, registration.value);
  // The Scope config refuses a private address with config.invalid, which `handle` answers with a 409.
  await now.scope.config.set(mcpConfig(registration), { ifRevision: 0 });
  // The next Turn runs the new version of the Agent, which has the Tools of the server.
  await now.scope.agents.put(mcpDeskSpec(options.model));
  // An OAuth server lists its Tools only for a User with a grant, thus the first list waits for the Connection.
  if (registration.auth !== "oauth") await discover(options, now);
  return undefined;
}

/**
 * Starts the consent flow for the User and returns the URL of the consent page. The callback sends the browser back
 * to the scenario.
 */
async function connect(options: McpRouteOptions, now: Current): Promise<Response> {
  if (!("origin" in options.oauth)) return routeError(409, "playground.oauthUnavailable", options.oauth.reason);
  const { authUrl } = await now.scope.mcp.authorize({
    serverId: SERVER,
    user: options.user,
    returnTo: `${options.oauth.origin}/#${MCP}`,
  });
  return Response.json({ authUrl });
}

/**
 * Cancels the Turn and destroys the disposable Scope, which deletes its registration, its Scope credential, the
 * Connections, the cached tool lists and the Thread. The next generation has a new Scope id. The Provider setup is
 * not in a Scope, thus it stays.
 */
async function reset(options: McpRouteOptions): Promise<Response> {
  const now = await current(options);
  await now.thread.cancel().catch((caught: unknown) => {
    if (!(caught instanceof KarmiError)) throw caught;
  });
  // A reset that stopped after the destroy leaves a destroyed Scope. This reset then does the rest of the work.
  await now.scope.destroy().catch((caught: unknown) => conflictOf(caught, "scope.destroyed"));
  await now.stub.reset();
  return scenarioState(options);
}

/** One action of the scenario. It returns an answer, or nothing when the route answers with the state. */
type Action = (options: McpRouteOptions, now: Current, body: unknown) => Promise<Response | undefined | void>;

const ACTIONS: Record<string, Action> = {
  register,
  discover,
  connect,
  disconnect: (options, now) => now.scope.mcp.disconnect({ serverId: SERVER, user: options.user }),
  revoke: (_options, now) => now.scope.credentials.revoke(STATIC_CREDENTIAL),
};

async function handle(options: McpRouteOptions, request: Request, path: string): Promise<Response | undefined> {
  const [, name] = new RegExp(`^/api/scenarios/${MCP}/([a-z]+)$`).exec(path) ?? [];
  const action = name === undefined ? undefined : ACTIONS[name];
  if (!action || request.method !== "POST") return undefined;
  const body: unknown = await request.json().catch(() => undefined);
  try {
    const answer = await action(options, await current(options), body);
    return answer instanceof Response ? answer : await scenarioState(options);
  } catch (caught) {
    // The Framework refuses an action that does not fit the server, for example a Connection for a server without
    // OAuth. The page shows the code and the message of the Framework.
    return conflictOf(caught, "");
  }
}

/**
 * Creates the authenticated application routes of the remote MCP and OAuth Connections scenario. The scenario runs
 * in a disposable Scope. A reset destroys it and moves to a new Scope id.
 */
export function mcpScenarioRoutes(options: McpRouteOptions) {
  return {
    /** True when `scopeId` is the current disposable Scope. The access token opens no other one. */
    opens: async (scopeId: string) => (await current(options)).scopeId === scopeId,
    /** Returns the id of the current disposable Scope. */
    scopeId: async () => (await current(options)).scopeId,
    state: () => scenarioState(options),
    reset: () => reset(options),
    handle: (request: Request, path: string) => handle(options, request, path),
  };
}
