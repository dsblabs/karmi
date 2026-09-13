import type { ScopeId } from "./context";
import type { McpAuthConfig } from "./scope-config";

// The pure half of MCP OAuth: who holds a grant, how a catalogue partitions by holder, the shape of the
// deployment-level client identity (CIMD document and callback), the `state` a callback carries back, and
// the authorization servers that only take a pre-registered client. No network, no storage.

/** Who an OAuth grant belongs to: the Agent (agent-level) or the User (user-level); catalogues partition the same way. */
export type McpHolder = `agent:${string}` | `user:${string}`;

/** The holder a Turn resolves grants for; a user-level server on a user-less Thread has none. */
export function mcpHolder(
  level: "agent" | "user",
  agent: string | undefined,
  user: string | undefined,
): McpHolder | undefined {
  if (level === "user") return user === undefined ? undefined : `user:${user}`;
  return agent === undefined ? undefined : `agent:${agent}`;
}

/** The credential partition a catalogue is cached under: the grant holder for OAuth, one per Scope otherwise. */
export function mcpPartition(auth: McpAuthConfig | undefined, holder: McpHolder | undefined): string {
  return auth?.type === "oauth" && holder !== undefined ? holder : "scope";
}

/** How long a pending authorization may take between the redirect and the callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed before use, so a slow call cannot cross the line. */
const TOKEN_SKEW_MS = 30_000;

export function tokenFresh(expiresAt: number | undefined, now: number): boolean {
  return expiresAt === undefined || now + TOKEN_SKEW_MS < expiresAt;
}

/** When a token issued now expires, from the server's `expires_in` seconds; absent means it does not say. */
export function tokenExpiry(expiresIn: number | undefined, now: number): number | undefined {
  return expiresIn === undefined ? undefined : now + expiresIn * 1000;
}

// The `state` parameter round-trips through the authorization server; the Scope in it routes the callback
// to the right ScopeConfig, the nonce finds the pending row there. Neither may contain a dot.
export function encodeOAuthState(scope: ScopeId, nonce: string): string {
  return `${scope}.${nonce}`;
}

export function decodeOAuthState(state: string): { scope: ScopeId; nonce: string } | undefined {
  const [scope, nonce, ...rest] = state.split(".");
  if (!scope || !nonce || rest.length > 0) return undefined;
  return { scope, nonce };
}

export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const CLIENT_DOCUMENT_PATH = "/.well-known/karmi-mcp-client.json";

/** The Deployment's OAuth client identity: `createKarmi({ oauth })`, without which no OAuth server can be used. */
export interface McpClientIdentity {
  /** The public origin the Worker is reachable at, e.g. `https://agents.example.com`; no path. */
  origin: string;
  /** What consent screens show; defaults to the origin's hostname. */
  clientName?: string;
}

export function callbackUrl({ origin }: McpClientIdentity): string {
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

export function clientDocumentUrl({ origin }: McpClientIdentity): string {
  return `${origin}${CLIENT_DOCUMENT_PATH}`;
}

/** What `registerClient` sends when an authorization server offers neither CIMD nor a pre-registered client. */
export interface McpClientMetadata {
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type: "web";
}

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

/** The Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): `client_id` is its own URL. */
export function clientDocument(identity: McpClientIdentity): McpClientMetadata & { client_id: string } {
  return { client_id: clientDocumentUrl(identity), ...clientMetadata(identity) };
}

/** An authorization server that takes neither CIMD nor DCR, and where to register instead. */
export interface PreRegistration {
  issuer: string;
  name: string;
  registerAt: string;
  secretRequired: boolean;
  notes?: string;
}

// Secret-free data: karmi ships no OAuth apps; a Deployment registers its own and sets `auth.client`.
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

export function preRegistration(issuer: string): PreRegistration | undefined {
  const wanted = trimSlash(issuer);
  return PRE_REGISTRATION_REQUIRED.find((entry) => trimSlash(entry.issuer) === wanted);
}

/** An authorization server whose metadata advertises neither CIMD nor a registration endpoint takes only a pre-registered client. */
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
