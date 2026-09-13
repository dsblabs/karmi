import type { OAuthDiscoveryState, StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import type { Clock } from "./clock";
import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import { OAUTH_STATE_TTL_MS, type McpHolder } from "./mcp-auth";
import type { GrantRecord, GrantStore, PendingAuthorization } from "./mcp-oauth";
import { credentialRef, sensitive, type SecretsProvider } from "./secrets";
import type { ThreadIdentity } from "./thread";

// The ScopeConfig Durable Object's OAuth rows: registered clients per issuer (secrets through the
// SecretsProvider, never in a row), one grant per (server, holder) with its refresh token, and the
// pending authorizations between redirect and callback. Tokens sit in the Scope's own SQLite like the
// Connection values beside them; the refresh token never leaves this object.

export const OAUTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_clients (issuer TEXT PRIMARY KEY, client_id TEXT NOT NULL, secret_ref TEXT, info_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS mcp_grants (server_id TEXT NOT NULL, holder TEXT NOT NULL, issuer TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, scope TEXT, discovery_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, holder));
  CREATE TABLE IF NOT EXISTS mcp_oauth_state (nonce TEXT PRIMARY KEY, server_id TEXT NOT NULL, holder TEXT NOT NULL, user_id TEXT, thread_json TEXT, return_to TEXT, verifier TEXT, discovery_json TEXT, expires_at INTEGER NOT NULL);
`;

type ClientRow = { issuer: string; client_id: string; secret_ref: string | null; info_json: string };
type GrantRow = {
  server_id: string;
  holder: string;
  issuer: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  discovery_json: string | null;
  updated_at: number;
};
type StateRow = {
  nonce: string;
  server_id: string;
  holder: string;
  user_id: string | null;
  thread_json: string | null;
  return_to: string | null;
  verifier: string | null;
  discovery_json: string | null;
  expires_at: number;
};

// The one decode point per JSON column; the rows are this object's own.
const decodeDiscovery = (json: string): OAuthDiscoveryState => JSON.parse(json);
const decodeClientInfo = (json: string): Omit<StoredOAuthClientInformation, "client_secret"> => JSON.parse(json);
const decodeThread = (json: string | null): ThreadIdentity | undefined =>
  json === null ? undefined : JSON.parse(json);

/** Where a pending authorization returns to: the Thread whose Step parked, and the page the human asked for. */
export interface PendingAuthorizationRow {
  nonce: string;
  serverId: string;
  holder: McpHolder;
  user?: string;
  thread?: ThreadIdentity;
  returnTo?: string;
  expiresAt: number;
}

const decodeGrant = (row: GrantRow): GrantRecord => ({
  issuer: row.issuer,
  accessToken: row.access_token,
  ...(row.refresh_token !== null && { refreshToken: row.refresh_token }),
  ...(row.expires_at !== null && { expiresAt: row.expires_at }),
  ...(row.scope !== null && { scope: row.scope }),
  ...(row.discovery_json !== null && { discovery: decodeDiscovery(row.discovery_json) }),
});

export interface OAuthStoreHost {
  sql: SqlStorage;
  clock: Clock;
  secrets: SecretsProvider;
  scope: ScopeId;
}

/** A DCR-issued client secret is stored as this Scope credential, named from a digest of its issuer. */
const secretName = (issuer: string) =>
  `__mcp-client-${Array.from(new TextEncoder().encode(issuer))
    .reduce((hash, byte) => Math.imul(hash ^ byte, 0x01000193) >>> 0, 0x811c9dc5)
    .toString(16)}`;

export class SqlGrantStore implements GrantStore {
  /** The pending authorization this store works on: the callback's, or the one `mintPending` created. */
  private nonce: string | undefined;

  constructor(
    private readonly host: OAuthStoreHost,
    private readonly serverId: string,
    private readonly holder: McpHolder,
    private readonly pendingInput?: { nonce?: string; user?: string; thread?: ThreadIdentity; returnTo?: string },
  ) {
    this.nonce = pendingInput?.nonce;
  }

  private get sql(): SqlStorage {
    return this.host.sql;
  }

  async client(issuer: string): Promise<StoredOAuthClientInformation | undefined> {
    const row = this.sql.exec<ClientRow>("SELECT * FROM mcp_clients WHERE issuer = ?", issuer).toArray()[0];
    if (!row) return undefined;
    const info: StoredOAuthClientInformation = { ...decodeClientInfo(row.info_json), client_id: row.client_id, issuer };
    if (row.secret_ref === null) return info;
    const secret = await this.host.secrets.resolve({ scope: this.host.scope, ref: row.secret_ref });
    // A registration whose secret is gone is no registration; dropping it makes the SDK register again.
    if (!secret) {
      this.dropClient(issuer);
      return undefined;
    }
    return { ...info, client_secret: secret.value.expose() };
  }

  async saveClient(issuer: string, info: StoredOAuthClientInformation): Promise<void> {
    const { client_secret, ...rest } = info;
    let secretRef: string | null = null;
    if (client_secret !== undefined) {
      const { secrets, scope } = this.host;
      if (!secrets.put)
        throw new KarmiError(
          "mcp.oauth.failed",
          `The authorization server ${issuer} issued a client secret, but the configured SecretsProvider is read-only; pre-register a client instead.`,
        );
      secretRef = credentialRef("scope", secretName(issuer));
      await secrets.put({ scope, ref: secretRef }, sensitive(client_secret));
    }
    this.sql.exec(
      "INSERT INTO mcp_clients (issuer, client_id, secret_ref, info_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (issuer) DO UPDATE SET client_id = excluded.client_id, secret_ref = excluded.secret_ref, info_json = excluded.info_json, created_at = excluded.created_at",
      issuer,
      info.client_id,
      secretRef,
      JSON.stringify(rest),
      this.host.clock.now(),
    );
  }

  dropClient(issuer: string): void {
    this.sql.exec("DELETE FROM mcp_clients WHERE issuer = ?", issuer);
  }

  grant(): GrantRecord | undefined {
    const row = this.sql
      .exec<GrantRow>("SELECT * FROM mcp_grants WHERE server_id = ? AND holder = ?", this.serverId, this.holder)
      .toArray()[0];
    return row && decodeGrant(row);
  }

  saveGrant(record: GrantRecord): void {
    this.sql.exec(
      "INSERT INTO mcp_grants (server_id, holder, issuer, access_token, refresh_token, expires_at, scope, discovery_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (server_id, holder) DO UPDATE SET issuer = excluded.issuer, access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, discovery_json = excluded.discovery_json, updated_at = excluded.updated_at",
      this.serverId,
      this.holder,
      record.issuer,
      record.accessToken,
      record.refreshToken ?? null,
      record.expiresAt ?? null,
      record.scope ?? null,
      record.discovery ? JSON.stringify(record.discovery) : null,
      this.host.clock.now(),
    );
  }

  dropGrant(): void {
    this.sql.exec("DELETE FROM mcp_grants WHERE server_id = ? AND holder = ?", this.serverId, this.holder);
  }

  private pendingRow(): StateRow | undefined {
    if (this.nonce === undefined) return undefined;
    return this.sql.exec<StateRow>("SELECT * FROM mcp_oauth_state WHERE nonce = ?", this.nonce).toArray()[0];
  }

  pending(): PendingAuthorization | undefined {
    const row = this.pendingRow();
    if (!row) return undefined;
    return {
      nonce: row.nonce,
      ...(row.verifier !== null && { verifier: row.verifier }),
      ...(row.discovery_json !== null && { discovery: decodeDiscovery(row.discovery_json) }),
    };
  }

  mintPending(): PendingAuthorization {
    const now = this.host.clock.now();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const input = this.pendingInput ?? {};
    this.sql.exec("DELETE FROM mcp_oauth_state WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO mcp_oauth_state (nonce, server_id, holder, user_id, thread_json, return_to, verifier, discovery_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
      nonce,
      this.serverId,
      this.holder,
      input.user ?? null,
      input.thread ? JSON.stringify(input.thread) : null,
      input.returnTo ?? null,
      now + OAUTH_STATE_TTL_MS,
    );
    this.nonce = nonce;
    return { nonce };
  }

  savePending(patch: Partial<Omit<PendingAuthorization, "nonce">>): void {
    if (this.nonce === undefined) return;
    if (patch.verifier !== undefined)
      this.sql.exec("UPDATE mcp_oauth_state SET verifier = ? WHERE nonce = ?", patch.verifier, this.nonce);
    if (patch.discovery !== undefined)
      this.sql.exec(
        "UPDATE mcp_oauth_state SET discovery_json = ? WHERE nonce = ?",
        JSON.stringify(patch.discovery),
        this.nonce,
      );
  }

  saveDiscovery(discovery: OAuthDiscoveryState): void {
    this.sql.exec(
      "UPDATE mcp_grants SET discovery_json = ? WHERE server_id = ? AND holder = ?",
      JSON.stringify(discovery),
      this.serverId,
      this.holder,
    );
  }

  /** Forgets the pending authorization once its callback has been handled, whichever way it went. */
  dropPending(): void {
    if (this.nonce === undefined) return;
    this.sql.exec("DELETE FROM mcp_oauth_state WHERE nonce = ?", this.nonce);
  }
}

/** The pending authorization a callback names, if it is still open. */
export function readPending(sql: SqlStorage, nonce: string, now: number): PendingAuthorizationRow | undefined {
  const row = sql.exec<StateRow>("SELECT * FROM mcp_oauth_state WHERE nonce = ?", nonce).toArray()[0];
  if (!row || row.expires_at < now) return undefined;
  const holder = row.holder;
  if (!isHolder(holder)) return undefined;
  const thread = decodeThread(row.thread_json);
  return {
    nonce: row.nonce,
    serverId: row.server_id,
    holder,
    ...(row.user_id !== null && { user: row.user_id }),
    ...(thread && { thread }),
    ...(row.return_to !== null && { returnTo: row.return_to }),
    expiresAt: row.expires_at,
  };
}

export function isHolder(value: string): value is McpHolder {
  return value.startsWith("agent:") || value.startsWith("user:");
}

/** The servers a holder has grants for, as Connection names `mcp:<serverId>`. */
export function listGrants(sql: SqlStorage, holder: McpHolder): { name: string; updatedAt: number }[] {
  return sql
    .exec<{ server_id: string; updated_at: number }>(
      "SELECT server_id, updated_at FROM mcp_grants WHERE holder = ? ORDER BY server_id",
      holder,
    )
    .toArray()
    .map((row) => ({ name: `mcp:${row.server_id}`, updatedAt: row.updated_at }));
}
