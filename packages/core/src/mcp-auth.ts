import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import type { McpAuthConfig } from "./scope-config";

// The pure half of MCP OAuth: who holds a grant, how a catalogue partitions by Holder, the shape of the
// Deployment's Client identity (the CIMD document and the callback), the `state` a callback carries back,
// and the authorization servers that only take a pre-registered client. It does no network or storage I/O.

/**
 * The Holder of an OAuth grant: the Agent for an agent-level server or the User for a user-level one.
 * Catalogues partition by the same key.
 */
export type McpHolder = `agent:${string}` | `user:${string}`;

/** The Holder a Turn resolves grants for, or undefined when a user-level server runs on a user-less Thread. */
export function mcpHolder(
  level: "agent" | "user",
  agent: string | undefined,
  user: string | undefined,
): McpHolder | undefined {
  if (level === "user") return user === undefined ? undefined : `user:${user}`;
  return agent === undefined ? undefined : `agent:${agent}`;
}

/** The server and the Agent or User a grant request concerns. */
export interface McpHolderRef {
  serverId: string;
  /** The Agent, for an agent-level server. */
  agent?: string;
  /** The User, for a user-level server. */
  user?: string;
}

/** The Holder `ref` names for an OAuth server, or the error explaining why it names none. */
export function resolveHolder(
  auth: McpAuthConfig | undefined,
  ref: McpHolderRef,
): { ok: true; level: "agent" | "user"; holder: McpHolder } | { ok: false; error: KarmiError } {
  if (auth?.type !== "oauth")
    return {
      ok: false,
      error: new KarmiError("mcp.oauth.notOAuth", `MCP server "${ref.serverId}" is not configured for OAuth.`),
    };
  const holder = mcpHolder(auth.level, ref.agent, ref.user);
  if (holder === undefined)
    return {
      ok: false,
      error: new KarmiError(
        "mcp.oauth.failed",
        `MCP server "${ref.serverId}" holds ${auth.level}-level grants; pass the ${auth.level} it is for.`,
      ),
    };
  return { ok: true, level: auth.level, holder };
}

/**
 * The Partition a catalogue is cached under. It is the grant Holder for an OAuth server and `scope` otherwise.
 */
export function mcpPartition(auth: McpAuthConfig | undefined, holder: McpHolder | undefined): string {
  return auth?.type === "oauth" && holder !== undefined ? holder : "scope";
}

/** How long a pending authorization may take between the redirect and the callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed before use, so it cannot expire during a slow call. */
const TOKEN_SKEW_MS = 30_000;

/**
 * Whether an access token expiring at `expiresAt` is still usable at `now`, with a safety margin. A token
 * without an expiry is always fresh.
 */
export function tokenFresh(expiresAt: number | undefined, now: number): boolean {
  return expiresAt === undefined || now + TOKEN_SKEW_MS < expiresAt;
}

/** When a token issued now expires, from the server's `expires_in` seconds. Undefined when the server did not say. */
export function tokenExpiry(expiresIn: number | undefined, now: number): number | undefined {
  return expiresIn === undefined ? undefined : now + expiresIn * 1000;
}

/**
 * The `state` parameter that round-trips through the authorization server. The Scope routes the callback
 * to its ScopeConfig and the nonce finds the pending row there. Neither may contain a dot.
 */
export function encodeOAuthState(scope: ScopeId, nonce: string): string {
  return `${scope}.${nonce}`;
}

/** The Scope and nonce in a `state` parameter, or undefined when it is malformed. */
export function decodeOAuthState(state: string): { scope: ScopeId; nonce: string } | undefined {
  const [scope, nonce, ...rest] = state.split(".");
  if (!scope || !nonce || rest.length > 0) return undefined;
  return { scope, nonce };
}

/** The path of the one OAuth callback route every consent flow returns to. */
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
/** The path the Client ID Metadata Document is served at. */
export const CLIENT_DOCUMENT_PATH = "/.well-known/karmi-mcp-client.json";

/**
 * The Deployment's Client identity, given as `createKarmi({ oauth })`. No OAuth server can be used without it.
 */
export interface McpClientIdentity {
  /** The public origin the Worker is reachable at, with no path, e.g. `https://agents.example.com`. */
  origin: string;
  /** The name consent screens show. Defaults to the origin's hostname. */
  clientName?: string;
}

/** The absolute URL of the OAuth callback route for `identity`. */
export function callbackUrl({ origin }: McpClientIdentity): string {
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

/** The absolute URL of the Client ID Metadata Document for `identity`. It is also the `client_id`. */
export function clientDocumentUrl({ origin }: McpClientIdentity): string {
  return `${origin}${CLIENT_DOCUMENT_PATH}`;
}

/**
 * The client metadata sent to Dynamic Client Registration when an authorization server offers neither
 * CIMD nor a pre-registered client.
 */
export interface McpClientMetadata {
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type: "web";
}

/** The client metadata for `identity`, as Dynamic Client Registration sends it. */
export function clientMetadata(identity: McpClientIdentity): McpClientMetadata {
  return {
    client_name: identity.clientName ?? new URL(identity.origin).hostname,
    client_uri: identity.origin,
    redirect_uris: [callbackUrl(identity)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}

/**
 * The Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): `client_id` is its own URL.
 */
export function clientDocument(identity: McpClientIdentity): McpClientMetadata & { client_id: string } {
  return { client_id: clientDocumentUrl(identity), ...clientMetadata(identity) };
}

/**
 * An authorization server that takes neither CIMD nor Dynamic Client Registration, with where to register
 * instead.
 */
export interface PreRegistration {
  issuer: string;
  /** The vendor's name, for the error message. */
  name: string;
  /** The URL of the vendor's registration page. */
  registerAt: string;
  /** Whether the vendor issues a client secret that must be configured too. */
  secretRequired: boolean;
  /** Vendor-specific advice appended to the error message. */
  notes?: string;
}

/**
 * The authorization servers known to take only a pre-registered client. karmi ships no OAuth apps of its
 * own, so a Deployment registers one and sets `auth.client`.
 */
export const PRE_REGISTRATION_REQUIRED: readonly PreRegistration[] = Object.freeze([
  {
    issuer: "https://github.com/login/oauth",
    name: "GitHub",
    registerAt: "https://github.com/settings/developers",
    secretRequired: true,
    notes: "An OAuth App or GitHub App; the callback URL must match exactly.",
  },
  {
    issuer: "https://mcp.slack.com",
    name: "Slack",
    registerAt: "https://api.slack.com/apps",
    secretRequired: true,
    notes: "Only directory-published or internal Slack apps may use MCP.",
  },
  {
    issuer: "https://accounts.google.com",
    name: "Google",
    registerAt: "https://console.cloud.google.com/auth/clients",
    secretRequired: true,
    notes: "Add the callback URL to the client's authorized redirect URIs.",
  },
  {
    issuer: "https://mcp.hubspot.com",
    name: "HubSpot",
    registerAt: "https://developers.hubspot.com/",
    secretRequired: true,
    notes: "A user-level application with the scopes the server lists.",
  },
  {
    issuer: "https://vercel.com",
    name: "Vercel",
    registerAt: "https://vercel.com/docs/mcp",
    secretRequired: true,
    notes: "Vercel only serves clients it has reviewed and approved.",
  },
]);

const trimSlash = (issuer: string) => issuer.replace(/\/+$/, "");

/** The known pre-registration entry for `issuer`, ignoring trailing slashes, or undefined. */
export function preRegistration(issuer: string): PreRegistration | undefined {
  const wanted = trimSlash(issuer);
  return PRE_REGISTRATION_REQUIRED.find((entry) => trimSlash(entry.issuer) === wanted);
}

/**
 * Whether an authorization server's metadata advertises neither CIMD nor a registration endpoint, so only
 * a pre-registered client can be used with it.
 */
export function needsPreRegistration(metadata: {
  client_id_metadata_document_supported?: boolean | undefined;
  registration_endpoint?: string | undefined;
}): boolean {
  return metadata.client_id_metadata_document_supported !== true && metadata.registration_endpoint === undefined;
}

/** The message a `PreRegistrationRequired` config error carries: the vendor's checklist when known. */
export function preRegistrationMessage(serverId: string, issuer: string, identity: McpClientIdentity): string {
  const known = preRegistration(issuer);
  const where = known
    ? `Register a ${known.name} client at ${known.registerAt}${known.secretRequired ? " (a client secret is required)" : ""}${known.notes ? `; ${known.notes}` : "."}`
    : "Register a client with the authorization server.";
  return `MCP server "${serverId}": its authorization server ${issuer} supports neither Client ID Metadata Documents nor Dynamic Client Registration. ${where} Use the callback URL ${callbackUrl(identity)}, then set auth.client { id, secret? } on the server.`;
}
