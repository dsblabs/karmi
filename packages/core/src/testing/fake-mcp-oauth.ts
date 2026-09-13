// An OAuth 2.1 authorization server and resource-server gate for `fakeMcpServer`: RFC 9728 protected
// resource metadata, RFC 8414 server metadata, PKCE (S256 only), RFC 8707 `resource`, RFC 9207 `iss`,
// dynamic registration, refresh-token rotation and `insufficient_scope` challenges. A test plays the
// human with `approve(authUrl)` and feeds the answer to `karmi.oauth.handle`.

export interface FakeMcpOAuthOptions {
  /** Scopes the protected resource advertises; a token is granted exactly what it asked for. */
  scopes?: string[];
  /** Tool name → scope a call needs; a token without it is answered `403 insufficient_scope`. */
  requires?: Record<string, string>;
  /** Advertise Client ID Metadata Document support (default `true`). */
  cimd?: boolean;
  /** Offer dynamic client registration (default `true`), issuing a client secret when `dcrSecret`. */
  dcr?: boolean;
  dcrSecret?: boolean;
  /** Pre-registered clients accepted by id, with the secret each must present. */
  clients?: Record<string, { secret?: string }>;
  /** Access tokens live this many seconds (default 3600). */
  expiresIn?: number;
  /** Rotate the refresh token on every refresh (default `true`). */
  rotate?: boolean;
  /** Challenge without `resource_metadata`, as some servers do; discovery must find the metadata itself. */
  bareChallenge?: boolean;
}

export interface FakeAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  state?: string;
  resource?: string;
}

export interface FakeTokenRequest {
  grantType: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  resource?: string;
}

export interface FakeMcpOAuth {
  readonly issuer: string;
  /** Every authorization request a human was sent to, in order. */
  readonly authorizations: FakeAuthorizationRequest[];
  /** Every token-endpoint request, in order. */
  readonly tokenRequests: FakeTokenRequest[];
  /** Every registration the server accepted, in order. */
  readonly registrations: Record<string, unknown>[];
  /** Every access token issued, in order. */
  readonly tokens: string[];
  /** Consents to the authorization at `authUrl`: the URL the browser is sent back to. */
  approve(authUrl: string): string;
  /** Refuses it: the callback URL carrying `error`. */
  deny(authUrl: string, error?: string): string;
  /** Invalidates every access token, and the refresh tokens too when asked; the next request is a 401. */
  revoke(options?: { refresh?: boolean }): void;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope?: string;
  resource?: string;
}

interface Grant {
  scope?: string;
  refresh?: string;
}

/** The server side: routes for the well-known and token endpoints, and the bearer gate for MCP requests. */
export interface FakeOAuthServer {
  readonly api: FakeMcpOAuth;
  handle(request: Request, url: URL): Promise<Response | undefined>;
  /** Whether an MCP request may proceed: nothing wrong, or the challenge to answer with. */
  gate(headers: Record<string, string>, tool: string | undefined): Response | undefined;
}

interface OAuthState {
  options: FakeMcpOAuthOptions;
  origin: string;
  resource: string;
  codes: Map<string, Code>;
  access: Map<string, Grant>;
  refresh: Map<string, Grant>;
  registered: Map<string, { secret?: string }>;
  n: number;
}

export function fakeOAuthServer(origin: string, resource: string, options: FakeMcpOAuthOptions): FakeOAuthServer {
  const state: OAuthState = {
    options,
    origin,
    resource,
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    registered: new Map(Object.entries(options.clients ?? {})),
    n: 0,
  };
  const api: FakeMcpOAuth = {
    issuer: origin,
    authorizations: [],
    tokenRequests: [],
    registrations: [],
    tokens: [],
    approve: (authUrl) => approve(state, api, authUrl),
    deny: (authUrl, error = "access_denied") => {
      const url = new URL(authUrl);
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("error", error);
      back.searchParams.set("error_description", "The user said no.");
      back.searchParams.set("iss", origin);
      const nonce = url.searchParams.get("state");
      if (nonce !== null) back.searchParams.set("state", nonce);
      return back.href;
    },
    revoke: ({ refresh = false } = {}) => {
      state.access.clear();
      if (refresh) state.refresh.clear();
    },
  };
  return {
    api,
    handle: (request, url) => route(state, api, request, url),
    gate: (headers, tool) => gate(state, headers, tool),
  };
}

function metadata(state: OAuthState): { resource: Record<string, unknown>; server: Record<string, unknown> } {
  const { origin, options } = state;
  return {
    resource: {
      resource: state.resource,
      authorization_servers: [origin],
      ...(options.scopes && { scopes_supported: options.scopes }),
      bearer_methods_supported: ["header"],
    },
    server: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      ...(options.dcr !== false && { registration_endpoint: `${origin}/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      ...(options.scopes && { scopes_supported: options.scopes }),
      client_id_metadata_document_supported: options.cimd !== false,
      authorization_response_iss_parameter_supported: true,
    },
  };
}

async function route(state: OAuthState, api: FakeMcpOAuth, request: Request, url: URL): Promise<Response | undefined> {
  const { pathname } = url;
  const docs = metadata(state);
  if (request.method === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource"))
    return Response.json(docs.resource);
  if (request.method === "GET" && pathname.startsWith("/.well-known/oauth-authorization-server"))
    return Response.json(docs.server);
  if (request.method === "GET" && pathname.startsWith("/.well-known/openid-configuration"))
    return new Response("Not found", { status: 404 });
  if (pathname === "/register" && request.method === "POST") {
    if (state.options.dcr === false) return new Response("Not found", { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    api.registrations.push(body);
    const client_id = `dcr-${++state.n}`;
    const secret = state.options.dcrSecret ? `secret-${state.n}` : undefined;
    state.registered.set(client_id, secret === undefined ? {} : { secret });
    // A server that issues a secret expects it back; echoing the requested `none` would let the client skip it.
    return Response.json(
      {
        client_id,
        ...body,
        ...(secret !== undefined && { client_secret: secret, token_endpoint_auth_method: "client_secret_basic" }),
      },
      { status: 201 },
    );
  }
  if (pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    // `client_secret_basic` carries the credentials in the header; fold them in so one path checks them.
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (basic !== undefined) {
      const [id, secret] = atob(basic).split(":");
      if (id !== undefined) form.set("client_id", decodeURIComponent(id));
      if (secret !== undefined) form.set("client_secret", decodeURIComponent(secret));
    }
    return token(state, api, form);
  }
  if (pathname === "/authorize") return new Response("A browser would show a consent screen here.", { status: 200 });
  return undefined;
}

function approve(state: OAuthState, api: FakeMcpOAuth, authUrl: string): string {
  const url = new URL(authUrl);
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  const clientId = param("client_id") ?? "";
  const redirectUri = param("redirect_uri") ?? "";
  const request: FakeAuthorizationRequest = {
    clientId,
    redirectUri,
    codeChallenge: param("code_challenge") ?? "",
    codeChallengeMethod: param("code_challenge_method") ?? "",
    ...opt("scope", param("scope")),
    ...opt("state", param("state")),
    ...opt("resource", param("resource")),
  };
  api.authorizations.push(request);
  if (url.origin !== state.origin || url.pathname !== "/authorize")
    throw new Error(`Not this server's authorize URL: ${authUrl}`);
  if (param("response_type") !== "code" || request.codeChallengeMethod !== "S256")
    throw new Error("The authorization request is not an S256 code request.");
  if (!knownClient(state, clientId)) return api.deny(authUrl, "invalid_client");
  const code = `code-${++state.n}`;
  state.codes.set(code, {
    clientId,
    redirectUri,
    challenge: request.codeChallenge,
    ...(request.scope !== undefined && { scope: request.scope }),
    ...(request.resource !== undefined && { resource: request.resource }),
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("iss", state.origin);
  if (request.state !== undefined) back.searchParams.set("state", request.state);
  return back.href;
}

/** A CIMD client is any https URL with a path; a registered one is in the table. */
function knownClient(state: OAuthState, clientId: string): boolean {
  if (state.registered.has(clientId)) return true;
  if (state.options.cimd === false) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}

async function token(state: OAuthState, api: FakeMcpOAuth, form: URLSearchParams): Promise<Response> {
  const get = (name: string) => form.get(name) ?? undefined;
  const grantType = get("grant_type") ?? "";
  const clientId = get("client_id");
  const clientSecret = get("client_secret");
  api.tokenRequests.push({
    grantType,
    ...opt("clientId", clientId),
    ...opt("clientSecret", clientSecret),
    ...opt("scope", get("scope")),
    ...opt("resource", get("resource")),
  });
  const oauthError = (error: string, description: string) =>
    Response.json({ error, error_description: description }, { status: 400 });
  if (clientId === undefined || !knownClient(state, clientId)) return oauthError("invalid_client", "Unknown client.");
  const expected = state.registered.get(clientId)?.secret;
  if (expected !== undefined && clientSecret !== expected) return oauthError("invalid_client", "Bad client secret.");
  let grant: Grant;
  if (grantType === "authorization_code") {
    const code = get("code") ?? "";
    const issued = state.codes.get(code);
    state.codes.delete(code);
    if (!issued || issued.clientId !== clientId) return oauthError("invalid_grant", "Unknown code.");
    if (issued.redirectUri !== get("redirect_uri")) return oauthError("invalid_grant", "redirect_uri mismatch.");
    if ((await s256(get("code_verifier") ?? "")) !== issued.challenge)
      return oauthError("invalid_grant", "PKCE failed.");
    grant = issued.scope === undefined ? {} : { scope: issued.scope };
  } else if (grantType === "refresh_token") {
    const refresh = get("refresh_token") ?? "";
    const held = state.refresh.get(refresh);
    if (!held) return oauthError("invalid_grant", "Unknown refresh token.");
    if (state.options.rotate !== false) state.refresh.delete(refresh);
    grant = { ...(held.scope !== undefined && { scope: held.scope }), refresh };
  } else return oauthError("unsupported_grant_type", grantType);
  const access = `at-${++state.n}`;
  const refresh = state.options.rotate === false && grant.refresh !== undefined ? grant.refresh : `rt-${++state.n}`;
  const scope = grant.scope === undefined ? {} : { scope: grant.scope };
  state.access.set(access, scope);
  state.refresh.set(refresh, scope);
  api.tokens.push(access);
  return Response.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: state.options.expiresIn ?? 3600,
    refresh_token: refresh,
    ...scope,
  });
}

function gate(state: OAuthState, headers: Record<string, string>, tool: string | undefined): Response | undefined {
  const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1];
  const grant = bearer === undefined ? undefined : state.access.get(bearer);
  if (!grant) {
    const challenge = state.options.bareChallenge
      ? "Bearer"
      : `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource${new URL(state.resource).pathname}"`;
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": challenge } });
  }
  const needed = tool === undefined ? undefined : state.options.requires?.[tool];
  if (needed !== undefined && !(grant.scope ?? "").split(" ").includes(needed))
    return new Response("Forbidden", {
      status: 403,
      headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${needed}"` },
    });
  return undefined;
}

/** A key only when there is a value, so optional fields stay absent rather than `undefined`. */
function opt<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
