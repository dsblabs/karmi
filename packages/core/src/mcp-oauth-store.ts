import type { OAuthDiscoveryState, StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import { and, asc, eq, lt } from "drizzle-orm";
import type { Clock } from "./clock";
import { mcpClients, mcpGrants, mcpOAuthState, type ScopeConfigDatabase } from "./db/scope-config/schema";
import type { ScopeId } from "./context";
import { sha256Hex } from "./digest";
import { KarmiError } from "./errors";
import { OAUTH_STATE_TTL_MS, type McpHolder } from "./mcp-auth";
import type { GrantRecord, GrantStore, PendingAuthorization } from "./mcp-oauth";
import { credentialRef, sensitive, type SecretsProvider } from "./secrets";
import type { ThreadIdentity } from "./thread";

// The ScopeConfig Durable Object's OAuth rows: registered clients per issuer (secrets through the
// SecretsProvider, never in a row), one grant per (server, holder) with its refresh token, and the
// pending authorizations between redirect and callback. Tokens sit in the Scope's own SQLite like the
// Connection values beside them. The refresh token never leaves this object.

type GrantRow = typeof mcpGrants.$inferSelect;

/** A pending authorization as stored, with where its callback returns to. */
export interface PendingAuthorizationRow {
  nonce: string;
  serverId: string;
  holder: McpHolder;
  /** The User the consent was requested for. */
  user?: string;
  /** The Thread whose Step parked awaiting consent. The callback wakes it. */
  thread?: ThreadIdentity;
  /** The page the human is redirected to after the callback. */
  returnTo?: string;
  /** When the authorization lapses, as epoch milliseconds. */
  expiresAt: number;
}

const decodeGrant = (row: GrantRow): GrantRecord => ({
  issuer: row.issuer,
  accessToken: row.accessToken,
  ...(row.refreshToken !== null && { refreshToken: row.refreshToken }),
  ...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
  ...(row.scope !== null && { scope: row.scope }),
  ...(row.discovery !== null && { discovery: row.discovery }),
});

/** What a SqlGrantStore needs from the Durable Object that owns it. */
export interface OAuthStoreHost {
  db: ScopeConfigDatabase;
  clock: Clock;
  secrets: SecretsProvider;
  scope: ScopeId;
}

/** A DCR-issued client secret is stored as this Scope credential, named from a digest of its issuer. */
const secretName = async (issuer: string) => `__mcp-client-${(await sha256Hex(issuer)).slice(0, 16)}`;

/** The GrantStore over the ScopeConfig Durable Object's SQLite, bound to one server and Holder. */
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

  private get db(): ScopeConfigDatabase {
    return this.host.db;
  }

  async client(issuer: string): Promise<StoredOAuthClientInformation | undefined> {
    const row = this.db.select().from(mcpClients).where(eq(mcpClients.issuer, issuer)).get();
    if (!row) return undefined;
    const info: StoredOAuthClientInformation = { ...row.info, client_id: row.clientId, issuer };
    if (row.secretRef === null) return info;
    const secret = await this.host.secrets.resolve({ scope: this.host.scope, ref: row.secretRef });
    // Dropping a registration whose secret is gone makes the SDK register again.
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
      secretRef = credentialRef("scope", await secretName(issuer));
      await secrets.put({ scope, ref: secretRef }, sensitive(client_secret));
    }
    const values = { clientId: info.client_id, secretRef, info: rest, createdAt: this.host.clock.now() };
    this.db
      .insert(mcpClients)
      .values({ issuer, ...values })
      .onConflictDoUpdate({ target: mcpClients.issuer, set: values })
      .run();
  }

  dropClient(issuer: string): void {
    this.db.delete(mcpClients).where(eq(mcpClients.issuer, issuer)).run();
  }

  grant(): GrantRecord | undefined {
    const row = this.db.select().from(mcpGrants).where(this.grantKey()).get();
    return row && decodeGrant(row);
  }

  saveGrant(record: GrantRecord): void {
    const values = {
      issuer: record.issuer,
      accessToken: record.accessToken,
      refreshToken: record.refreshToken ?? null,
      expiresAt: record.expiresAt ?? null,
      scope: record.scope ?? null,
      discovery: record.discovery ?? null,
      updatedAt: this.host.clock.now(),
    };
    this.db
      .insert(mcpGrants)
      .values({ serverId: this.serverId, holder: this.holder, ...values })
      .onConflictDoUpdate({ target: [mcpGrants.serverId, mcpGrants.holder], set: values })
      .run();
  }

  dropGrant(): void {
    this.db.delete(mcpGrants).where(this.grantKey()).run();
  }

  private grantKey() {
    return and(eq(mcpGrants.serverId, this.serverId), eq(mcpGrants.holder, this.holder));
  }

  pending(): PendingAuthorization | undefined {
    if (this.nonce === undefined) return undefined;
    const row = this.db.select().from(mcpOAuthState).where(eq(mcpOAuthState.nonce, this.nonce)).get();
    if (!row) return undefined;
    return {
      nonce: row.nonce,
      ...(row.verifier !== null && { verifier: row.verifier }),
      ...(row.discovery !== null && { discovery: row.discovery }),
    };
  }

  mintPending(): PendingAuthorization {
    const now = this.host.clock.now();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const input = this.pendingInput ?? {};
    this.db.delete(mcpOAuthState).where(lt(mcpOAuthState.expiresAt, now)).run();
    this.db
      .insert(mcpOAuthState)
      .values({
        nonce,
        serverId: this.serverId,
        holder: this.holder,
        userId: input.user ?? null,
        thread: input.thread ?? null,
        returnTo: input.returnTo ?? null,
        expiresAt: now + OAUTH_STATE_TTL_MS,
      })
      .run();
    this.nonce = nonce;
    return { nonce };
  }

  savePending(patch: Partial<Omit<PendingAuthorization, "nonce">>): void {
    if (this.nonce === undefined) return;
    const set = {
      ...(patch.verifier !== undefined && { verifier: patch.verifier }),
      ...(patch.discovery !== undefined && { discovery: patch.discovery }),
    };
    if (Object.keys(set).length > 0)
      this.db.update(mcpOAuthState).set(set).where(eq(mcpOAuthState.nonce, this.nonce)).run();
  }

  saveDiscovery(discovery: OAuthDiscoveryState): void {
    this.db.update(mcpGrants).set({ discovery }).where(this.grantKey()).run();
  }

  /** Forgets the pending authorization once its callback has been handled, whichever way it went. */
  dropPending(): void {
    if (this.nonce === undefined) return;
    this.db.delete(mcpOAuthState).where(eq(mcpOAuthState.nonce, this.nonce)).run();
  }
}

/** The pending authorization a callback names, if it is still open. */
export function readPending(db: ScopeConfigDatabase, nonce: string, now: number): PendingAuthorizationRow | undefined {
  const row = db.select().from(mcpOAuthState).where(eq(mcpOAuthState.nonce, nonce)).get();
  if (!row || row.expiresAt < now) return undefined;
  const holder = row.holder;
  if (!isHolder(holder)) return undefined;
  return {
    nonce: row.nonce,
    serverId: row.serverId,
    holder,
    ...(row.userId !== null && { user: row.userId }),
    ...(row.thread !== null && { thread: row.thread }),
    ...(row.returnTo !== null && { returnTo: row.returnTo }),
    expiresAt: row.expiresAt,
  };
}

/** Whether `value` is a well-formed McpHolder. */
export function isHolder(value: string): value is McpHolder {
  return value.startsWith("agent:") || value.startsWith("user:");
}

/** The servers a holder has grants for, as Connection names `mcp:<serverId>`. */
export function listGrants(db: ScopeConfigDatabase, holder: McpHolder): { name: string; updatedAt: number }[] {
  return db
    .select({ serverId: mcpGrants.serverId, updatedAt: mcpGrants.updatedAt })
    .from(mcpGrants)
    .where(eq(mcpGrants.holder, holder))
    .orderBy(asc(mcpGrants.serverId))
    .all()
    .map((row) => ({ name: `mcp:${row.serverId}`, updatedAt: row.updatedAt }));
}
