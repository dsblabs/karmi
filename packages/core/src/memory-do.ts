import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { ftsQuery, RECALL_LIMIT, type MemoryNote, type MemoryView, type MemoryWrite } from "./memory";
import { ok, type Outcome } from "./outcome";

// One Memory Durable Object holds what every Agent in a Scope remembers about one User: a head row with
// the Profile as JSON and an FTS5 table of Notes. The Durable Object is the only writer, so a `recall`
// after a `remember` in the same Turn always sees the Note.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_head (scope_id TEXT NOT NULL, user_id TEXT NOT NULL, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(text, agent_id UNINDEXED, created_at UNINDEXED);
`;

type HeadRow = { scope_id: string; user_id: string; profile_json: string; updated_at: number };
type NoteRow = { id: number; text: string; agent_id: string; created_at: number };

// The decode point for the one JSON column this Durable Object writes.
const decodeProfile = (json: string): Record<string, unknown> => JSON.parse(json);

/**
 * The Durable Object behind one User's Memory in a Scope. Every method returns an Outcome. The Thread
 * Durable Object and `scope.users.memory` are its only callers.
 */
export abstract class MemoryDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Returns the head row, or undefined before the first write. A read never creates one, so reading a
  // User who has no Memory leaves no storage behind.
  private head(scope: ScopeId, user: string): HeadRow | undefined {
    const head = this.sql.exec<HeadRow>("SELECT * FROM memory_head").toArray()[0];
    // Only a keys.ts bug can address one User's object as another. Refusing keeps it from leaking Memory.
    if (head && (head.scope_id !== scope || head.user_id !== user))
      throw new Error(`Memory for "${head.scope_id}/${head.user_id}" was addressed as "${scope}/${user}".`);
    return head;
  }

  /** Returns the Profile and the `limit` most recent Notes. */
  get(scope: ScopeId, user: string, limit: number): Outcome<MemoryView> {
    const head = this.head(scope, user);
    if (!head) return ok({ profile: {}, notes: [] });
    const rows = this.sql
      .exec<NoteRow>("SELECT rowid AS id, text, agent_id, created_at FROM notes ORDER BY rowid DESC LIMIT ?", limit)
      .toArray();
    return ok({ profile: decodeProfile(head.profile_json), notes: rows.map(toNote) });
  }

  /**
   * Merges `write.profile` into the Profile field by field, removing fields set to `null`, and appends
   * `write.note` when present. The caller has already checked the fields against the Agent's schema.
   */
  remember(scope: ScopeId, user: string, write: MemoryWrite): Outcome<void> {
    const now = this.deployment.clock.now();
    this.ctx.storage.transactionSync(() => {
      const profile = decodeProfile(this.head(scope, user)?.profile_json ?? "{}");
      for (const [field, value] of Object.entries(write.profile ?? {})) {
        if (value === null) delete profile[field];
        else profile[field] = value;
      }
      this.sql.exec("DELETE FROM memory_head");
      this.sql.exec(
        "INSERT INTO memory_head (scope_id, user_id, profile_json, updated_at) VALUES (?, ?, ?, ?)",
        scope,
        user,
        JSON.stringify(profile),
        now,
      );
      if (write.note !== undefined)
        this.sql.exec("INSERT INTO notes (text, agent_id, created_at) VALUES (?, ?, ?)", write.note, write.agent, now);
    });
    return ok(undefined);
  }

  /** Returns the Notes matching `query` by full-text search, best match first. A blank query matches none. */
  recall(scope: ScopeId, user: string, query: string): Outcome<MemoryNote[]> {
    const match = ftsQuery(query);
    if (!this.head(scope, user) || match === undefined) return ok([]);
    const rows = this.sql
      .exec<NoteRow>(
        `SELECT rowid AS id, text, agent_id, created_at FROM notes
        WHERE notes MATCH ? ORDER BY bm25(notes), rowid DESC LIMIT ?`,
        match,
        RECALL_LIMIT,
      )
      .toArray();
    return ok(rows.map(toNote));
  }

  /** Deletes the Profile, every Note and the object's storage. */
  async clear(scope: ScopeId, user: string): Promise<Outcome<void>> {
    this.head(scope, user);
    await this.ctx.storage.deleteAll();
    // deleteAll drops the tables too, and this instance may be called again before it is evicted.
    this.sql.exec(SCHEMA);
    return ok(undefined);
  }
}

function toNote(row: NoteRow): MemoryNote {
  return { id: row.id, text: row.text, agent: row.agent_id, at: row.created_at };
}
