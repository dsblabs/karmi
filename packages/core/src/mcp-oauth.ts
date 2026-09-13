import {
  auth,
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientInformationContext,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ScopeId } from "./context";
import { errorMessage, KarmiError } from "./errors";
import {
  callbackUrl,
  clientDocumentUrl,
  clientMetadata,
  encodeOAuthState,
  needsPreRegistration,
  preRegistrationMessage,
  tokenExpiry,
  type McpClientIdentity,
} from "./mcp-auth";

// The OAuth client the ScopeConfig Durable Object runs for one (server, holder): the SDK's `auth()` does
// discovery, PKCE, registration and the token requests; this provider is where it reads and writes what
// must persist, through a store the Durable Object implements on its SQLite. Nothing here logs a token.

/** One grant as stored: the tokens, the issuer they came from and the discovery that found it. */
export interface GrantRecord {
  issuer: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  discovery?: OAuthDiscoveryState;
}

/** One pending authorization: the PKCE verifier and discovery saved between the redirect and the callback. */
export interface PendingAuthorization {
  nonce: string;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

/** A pre-registered client for the server's issuer, its secret already resolved. */
export interface PreregisteredClient {
  client_id: string;
  client_secret?: string;
}

/** What the provider persists; bound to one (Scope, server, holder) and, on a callback, one pending nonce. */
export interface GrantStore {
  client(issuer: string): Promise<StoredOAuthClientInformation | undefined>;
  saveClient(issuer: string, info: StoredOAuthClientInformation): Promise<void>;
  dropClient(issuer: string): void;
  grant(): GrantRecord | undefined;
  saveGrant(record: GrantRecord): void;
  dropGrant(): void;
  /** The authorization this provider is completing, or the one it minted with `mintPending`. */
  pending(): PendingAuthorization | undefined;
  mintPending(): PendingAuthorization;
  savePending(patch: Partial<Omit<PendingAuthorization, "nonce">>): void;
  /** Discovery outside any pending authorization lands on the grant. */
  saveDiscovery(discovery: OAuthDiscoveryState): void;
}

export interface GrantProviderInput {
  scope: ScopeId;
  identity: McpClientIdentity;
  preregistered?: PreregisteredClient;
  store: GrantStore;
  now: () => number;
}

export class GrantProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization`: where the human must go. */
  authorizationUrl: URL | undefined;
  /** The issuer the SDK resolved for the current flow. */
  issuer: string | undefined;
  readonly store: GrantStore;
  readonly identity: McpClientIdentity;
  readonly preregistered: PreregisteredClient | undefined;

  constructor(private readonly input: GrantProviderInput) {
    this.store = input.store;
    this.identity = input.identity;
    this.preregistered = input.preregistered;
  }

  get redirectUrl(): string {
    return callbackUrl(this.input.identity);
  }

  get clientMetadataUrl(): string {
    return clientDocumentUrl(this.input.identity);
  }

  get clientMetadata(): ReturnType<typeof clientMetadata> {
    return clientMetadata(this.input.identity);
  }

  /** The pending row is minted before the flow starts, so discovery saved ahead of this call lands on it. */
  state(): string {
    const { store, scope } = this.input;
    return encodeOAuthState(scope, (store.pending() ?? store.mintPending()).nonce);
  }

  clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const { preregistered, store } = this.input;
    // A pre-registered client is stamped with the issuer it is configured for, so the SDK never re-saves it.
    if (preregistered) return Promise.resolve({ ...preregistered, ...(ctx && { issuer: ctx.issuer }) });
    const issuer = ctx?.issuer ?? this.issuer;
    return issuer === undefined ? Promise.resolve(undefined) : store.client(issuer);
  }

  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? info.issuer ?? this.issuer;
    if (issuer === undefined) throw new KarmiError("mcp.oauth.failed", "Client information arrived without an issuer.");
    return this.input.store.saveClient(issuer, info);
  }

  tokens(): StoredOAuthTokens | undefined {
    const grant = this.input.store.grant();
    if (!grant) return undefined;
    return {
      access_token: grant.accessToken,
      token_type: "bearer",
      issuer: grant.issuer,
      ...(grant.refreshToken !== undefined && { refresh_token: grant.refreshToken }),
      ...(grant.scope !== undefined && { scope: grant.scope }),
    };
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const { store, now } = this.input;
    const previous = store.grant();
    const issuer = ctx?.issuer ?? tokens.issuer ?? this.issuer ?? previous?.issuer;
    if (issuer === undefined) throw new KarmiError("mcp.oauth.failed", "Tokens arrived without an issuer.");
    const expiresAt = tokenExpiry(tokens.expires_in, now());
    // A server that rotates refresh tokens sends a new one; one that does not expects the old one to keep working.
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    const discovery = store.pending()?.discovery ?? previous?.discovery;
    store.saveGrant({
      issuer,
      accessToken: tokens.access_token,
      ...(refreshToken !== undefined && { refreshToken }),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(tokens.scope !== undefined && { scope: tokens.scope }),
      ...(discovery && { discovery }),
    });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.input.store.savePending({ verifier });
  }

  codeVerifier(): string {
    const verifier = this.input.store.pending()?.verifier;
    if (verifier === undefined)
      throw new KarmiError("mcp.oauth.state", "No pending authorization holds a PKCE verifier for this callback.");
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const { store } = this.input;
    return store.pending()?.discovery ?? store.grant()?.discovery;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    const { store } = this.input;
    if (store.pending()) store.savePending({ discovery });
    else store.saveDiscovery(discovery);
  }

  saveAuthorizationServerUrl(issuer: string): void {
    this.issuer = issuer;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const { store } = this.input;
    if (scope === "all" || scope === "tokens") store.dropGrant();
    if ((scope === "all" || scope === "client") && this.issuer !== undefined) store.dropClient(this.issuer);
  }
}

export interface FlowInput {
  provider: GrantProvider;
  serverId: string;
  serverUrl: string;
  fetch: typeof fetch;
}

/**
 * Starts an authorization for the human to complete: discovery, client identity, PKCE, and the URL to
 * visit. Always asks the authorization server afresh, so a settings page "reconnect" reconnects.
 */
export async function beginAuthorization(input: FlowInput, scope: string | undefined): Promise<URL> {
  const { provider } = input;
  provider.store.mintPending();
  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, {
      serverUrl: input.serverUrl,
      ...(scope !== undefined && { scope }),
      fetchFn: input.fetch,
      forceReauthorization: true,
    });
  } catch (caught) {
    throw flowError(input, caught);
  }
  if (result !== "REDIRECT" || !provider.authorizationUrl)
    throw new KarmiError(
      "mcp.oauth.failed",
      `MCP server "${input.serverId}": the authorization server issued no redirect.`,
    );
  return provider.authorizationUrl;
}

/** Redeems the callback's code under the pending authorization; the provider stores what comes back. */
export async function completeAuthorization(input: FlowInput, code: string, iss: string | undefined): Promise<void> {
  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(input.provider, {
      serverUrl: input.serverUrl,
      authorizationCode: code,
      ...(iss !== undefined && { iss }),
      fetchFn: input.fetch,
    });
  } catch (caught) {
    throw flowError(input, caught);
  }
  if (result !== "AUTHORIZED")
    throw new KarmiError("mcp.oauth.failed", `MCP server "${input.serverId}": the code exchange did not complete.`);
}

/**
 * Trades the refresh token for a new access token; `false` when the grant cannot be refreshed and the
 * human must consent again. A rejected refresh token drops the grant, so the next attempt asks anew.
 */
export async function refreshGrant(input: FlowInput): Promise<boolean> {
  const { provider } = input;
  const { store } = provider;
  const grant = store.grant();
  if (!grant?.refreshToken) return false;
  provider.issuer = grant.issuer;
  try {
    const discovery = grant.discovery ?? (await rediscover(input, store));
    const client = await provider.clientInformation({ issuer: grant.issuer });
    if (!client) return false;
    const resource = await selectResourceURL(input.serverUrl, provider, discovery.resourceMetadata);
    const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      ...(discovery.authorizationServerMetadata && { metadata: discovery.authorizationServerMetadata }),
      clientInformation: client,
      refreshToken: grant.refreshToken,
      ...(resource && { resource }),
      fetchFn: input.fetch,
    });
    provider.saveTokens({ ...tokens, issuer: grant.issuer }, { issuer: grant.issuer });
    return true;
  } catch (caught) {
    if (caught instanceof OAuthError) {
      if (caught.code === OAuthErrorCode.InvalidGrant) store.dropGrant();
      return false;
    }
    throw flowError(input, caught);
  }
}

async function rediscover(input: FlowInput, store: GrantStore): Promise<OAuthDiscoveryState> {
  const found = await discoverOAuthServerInfo(input.serverUrl, { fetchFn: input.fetch });
  const discovery: OAuthDiscoveryState = {
    authorizationServerUrl: found.authorizationServerUrl,
    ...(found.authorizationServerMetadata && { authorizationServerMetadata: found.authorizationServerMetadata }),
    ...(found.resourceMetadata && { resourceMetadata: found.resourceMetadata }),
  };
  store.saveDiscovery(discovery);
  return discovery;
}

// A flow that stopped because the authorization server takes only a pre-registered client is a Deployment
// configuration error with a checklist; anything else is the SDK's own account of what went wrong.
function flowError(input: FlowInput, caught: unknown): KarmiError {
  if (caught instanceof KarmiError) return caught;
  const { provider, serverId } = input;
  const metadata = provider.discoveryState()?.authorizationServerMetadata;
  const issuer = provider.issuer ?? metadata?.issuer;
  if (metadata && issuer !== undefined && !provider.preregistered && needsPreRegistration(metadata))
    return new KarmiError(
      "mcp.oauth.preRegistrationRequired",
      preRegistrationMessage(serverId, issuer, provider.identity),
    );
  return new KarmiError("mcp.oauth.failed", `MCP server "${serverId}": ${errorMessage(caught)}`);
}
