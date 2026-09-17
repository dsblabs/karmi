import type { Granularity, Karmi, MediaRef, Scope, Thread, ThreadIdentity, ThreadStatus } from "@karmi/core";
import { decodeApprovalAnswer, decodeCompact, decodeCreateThread, decodeTurnRequest, isGranularity } from "./decode";
import { errorResponse, HttpError } from "./errors";
import { discardMinted, readMultipartTurn } from "./multipart";
import { eventStream } from "./sse";

/** The identity a request acts as. It names the Scope and, when a person is behind the request, the User. */
export interface Principal {
  /** The id of the Scope every Thread of this request lives in. */
  scope: string;
  /** The User every Thread of this request belongs to. Absent for a service caller that drives user-less Threads. */
  user?: string;
}

/**
 * Your authentication. It reads whatever the request carries (a bearer token, a cookie, a query parameter
 * for WebSockets) and returns the Principal, or null for a 401. karmi defines no credential scheme of its own.
 */
export type Authenticate = (request: Request) => Principal | null | Promise<Principal | null>;

/** The options of `createHttpHandler`. */
export interface HttpHandlerOptions {
  /** The Deployment whose Threads the routes drive. */
  karmi: Karmi;
  /** The callback that turns a request into its Principal. See `Authenticate`. */
  authenticate: Authenticate;
}

/** A Thread as the routes return it: its identity, the key later routes take, and its current status. */
export type ThreadResource = ThreadIdentity & { key: string; status: ThreadStatus };

/** The mounted routes. */
export interface HttpHandler {
  /**
   * Answers a request under `/threads`, or returns undefined for any other path so the Worker can serve it
   * itself. WebSockets are owned by the Thread and need no Worker lifetime management.
   */
  handle(request: Request, ctx?: ExecutionContext): Promise<Response | undefined>;
  /** `handle` with a 404 for unmatched paths, shaped to be a Worker's `fetch` export. */
  fetch(request: Request, env?: unknown, ctx?: ExecutionContext): Promise<Response>;
}

const JSON_TYPE = "application/json";
const MULTIPART_TYPE = "multipart/form-data";

/**
 * Mounts REST, Server-Sent Events and WebSocket routes over the public Thread API. Every route first calls
 * `authenticate`; a null answer is a 401. A Thread key names Threads in every path, and a key whose User
 * differs from the Principal's is a 404. Errors are JSON `{ error: { code, message } }` with karmi's codes.
 */
export function createHttpHandler(options: HttpHandlerOptions): HttpHandler {
  const handle = async (request: Request, _ctx?: ExecutionContext): Promise<Response | undefined> => {
    const [root, key, action, arg, extra] = new URL(request.url).pathname.split("/").filter(Boolean);
    if (root !== "threads" || extra !== undefined) return undefined;
    try {
      const principal = await options.authenticate(request);
      if (!principal) throw new HttpError(401, "http.unauthorized", "Authentication required.");
      const scope = options.karmi.scope(principal.scope);
      if (key === undefined) return await collectionRoute(request, scope, principal);
      const thread = openOwnedThread(scope, key, principal);
      if (action === undefined) return await threadRoute(request, thread);
      if (arg !== undefined && action !== "approvals") return notFound();
      return await actionRoute(request, thread, action, arg);
    } catch (error) {
      return errorResponse(error);
    }
  };
  return {
    handle,
    fetch: async (request, _env, ctx) => (await handle(request, ctx)) ?? notFound(),
  };
}

// The key carries the User, so a Thread of another User is indistinguishable from a missing one.
function openOwnedThread(scope: Scope, key: string, principal: Principal): Thread {
  const thread = scope.thread(key);
  if (thread.identity.user !== principal.user) throw new HttpError(404, "http.notFound", "No such Thread.");
  return thread;
}

async function collectionRoute(request: Request, scope: Scope, principal: Principal): Promise<Response> {
  if (request.method === "GET") {
    const agent = new URL(request.url).searchParams.get("agent");
    if (!agent) throw new HttpError(400, "http.badRequest", "The agent query parameter is required.");
    return Response.json(await scope.threads.list({ agent, user: principal.user ?? null }));
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  const { agent, threadId } = decodeCreateThread(await readJson(request));
  const identity: ThreadIdentity = {
    agent,
    threadId: threadId ?? crypto.randomUUID(),
    ...(principal.user !== undefined && { user: principal.user }),
  };
  return Response.json(await toResource(scope.thread(identity)), { status: 201 });
}

async function toResource(thread: Thread): Promise<ThreadResource> {
  return { ...thread.identity, key: thread.key, status: await thread.status() };
}

async function threadRoute(request: Request, thread: Thread): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json(await toResource(thread));
  return thread.socket(await streamOptions(request, thread));
}

async function actionRoute(
  request: Request,
  thread: Thread,
  action: string,
  arg: string | undefined,
): Promise<Response> {
  switch (action) {
    case "events": {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const { after, granularity } = await streamOptions(request, thread);
      if (!request.headers.get("accept")?.includes("text/event-stream"))
        return Response.json(await thread.events(after === undefined ? {} : { after }));
      return eventStream(thread.subscribe({ ...(after !== undefined && { after }), granularity }), request.signal);
    }
    case "turns": {
      if (request.method !== "POST") return methodNotAllowed("POST");
      // Media uploaded for a multipart Turn belongs to the transport until `send()` accepts the Turn, so the
      // window covers the parse and the send and any throw out of it discards every ref minted inside. A JSON
      // Turn mints nothing, which leaves the discard a no-op.
      const minted: MediaRef[] = [];
      let receipt;
      try {
        const { input, steer } = contentType(request).startsWith(MULTIPART_TYPE)
          ? await readMultipartTurn(request, thread, minted)
          : decodeTurnRequest(await readJson(request));
        receipt = await thread.send(input, { steer });
      } catch (error) {
        await discardMinted(thread.uploads, minted);
        throw error;
      }
      return Response.json(receipt, { status: 202 });
    }
    case "approvals": {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const seq = Number(arg);
      if (arg === undefined || !Number.isInteger(seq) || seq < 1)
        throw new HttpError(404, "http.notFound", "An approval is addressed by the seq of its request.");
      await thread.approve(seq, decodeApprovalAnswer(await readJson(request)));
      return new Response(null, { status: 204 });
    }
    case "cancel":
      if (request.method !== "POST") return methodNotAllowed("POST");
      await thread.cancel();
      return new Response(null, { status: 204 });
    case "compact":
      if (request.method !== "POST") return methodNotAllowed("POST");
      await thread.compact(decodeCompact(await readJson(request, true)));
      return new Response(null, { status: 204 });
    default:
      return notFound();
  }
}

// `after` comes from the query or, on an EventSource reconnect, from `Last-Event-ID`. The status check turns a
// position past the end of the log into a 400 before any stream headers are sent, and a missing Thread into a 404.
async function streamOptions(request: Request, thread: Thread): Promise<{ after?: number; granularity: Granularity }> {
  const url = new URL(request.url);
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("after");
  const after = raw === null ? undefined : Number(raw);
  if (after !== undefined && (!Number.isInteger(after) || after < 0))
    throw new HttpError(400, "http.badRequest", "after must be a non-negative integer.");
  const granularity = url.searchParams.get("granularity") ?? "delta";
  if (!isGranularity(granularity))
    throw new HttpError(400, "http.badRequest", "granularity must be delta, part or turn.");
  const status = await thread.status();
  if (after !== undefined && after > status.seq)
    throw new HttpError(400, "http.badRequest", `The log ends at seq ${status.seq}.`);
  return { ...(after !== undefined && { after }), granularity };
}

function contentType(request: Request): string {
  return request.headers.get("content-type")?.toLowerCase() ?? "";
}

async function readJson(request: Request, optional = false): Promise<unknown> {
  const type = contentType(request);
  if (optional && !type && !request.body) return undefined;
  if (!type.startsWith(JSON_TYPE)) throw new HttpError(415, "http.unsupportedMediaType", "Send application/json.");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "http.badRequest", "The body is not valid JSON.");
  }
}

function notFound(): Response {
  return errorResponse(new HttpError(404, "http.notFound", "No such route."));
}

function methodNotAllowed(allow: string): Response {
  const response = errorResponse(new HttpError(405, "http.methodNotAllowed", `Use ${allow}.`));
  response.headers.set("allow", allow);
  return response;
}
