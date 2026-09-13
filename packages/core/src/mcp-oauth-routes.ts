import type { KarmiBindings } from "./bindings";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { CLIENT_DOCUMENT_PATH, clientDocument, decodeOAuthState, OAUTH_CALLBACK_PATH } from "./mcp-auth";
import { remote } from "./outcome";
import type { ScopeConfigDurableObject } from "./scope-config-do";
import type { ThreadDurableObject } from "./thread-do";

// The two fixed OAuth routes a Deployment mounts: the Client ID Metadata Document every authorization
// server may fetch, and the one exact callback every consent flow returns to. The callback hands the
// code to the Scope's ScopeConfig, which stores the tokens, then wakes the parked Thread by name.

export interface OAuthRoutes {
  /** Answers the client document and the callback; `undefined` for any other request, so a Worker can fall through. */
  handle(request: Request): Promise<Response | undefined>;
  /** What `/.well-known/karmi-mcp-client.json` serves; absent without `createKarmi({ oauth })`. */
  readonly clientDocument: ReturnType<typeof clientDocument> | undefined;
}

export function oauthRoutes(deployment: Deployment, bindings: KarmiBindings): OAuthRoutes {
  const identity = deployment.oauth;
  const document = identity && clientDocument(identity);
  return {
    clientDocument: document,
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname === CLIENT_DOCUMENT_PATH) {
        if (!document) return new Response("Not found", { status: 404 });
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        return Response.json(document, { headers: { "cache-control": "public, max-age=86400" } });
      }
      if (url.pathname !== OAUTH_CALLBACK_PATH) return undefined;
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return callback(deployment, bindings, url.searchParams);
    },
  };
}

async function callback(deployment: Deployment, bindings: KarmiBindings, params: URLSearchParams): Promise<Response> {
  const state = decodeOAuthState(params.get("state") ?? "");
  if (!state) return new Response("Missing or malformed state.", { status: 400 });
  const code = params.get("code") ?? undefined;
  const iss = params.get("iss") ?? undefined;
  const error = params.get("error") ?? undefined;
  const scopes = remote<ScopeConfigDurableObject>(bindings.KARMI_SCOPES, keys.config(state.scope));
  const result = await scopes.mcpCallback(state.scope, {
    nonce: state.nonce,
    ...(code !== undefined && { code }),
    ...(iss !== undefined && { iss }),
    ...(error !== undefined && { error }),
  });
  if (!result.ok) return new Response(new KarmiError(result.code, result.message).message, { status: 400 });
  const { thread, serverId, granted, reason, returnTo } = result.value;
  if (thread) {
    const threads = remote<ThreadDurableObject>(bindings.KARMI_THREADS, keys.thread(state.scope, thread.threadId));
    await threads.connected(
      { ...thread, scope: state.scope, create: false },
      { serverId, granted, ...(reason !== undefined && { reason }) },
    );
  }
  if (returnTo !== undefined) {
    const target = new URL(returnTo);
    target.searchParams.set("mcp", serverId);
    target.searchParams.set("connected", granted ? "true" : "false");
    return Response.redirect(target.href, 303);
  }
  return new Response(granted ? `Connected to ${serverId}. You can close this window.` : `Not connected: ${reason}`, {
    status: granted ? 200 : 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
