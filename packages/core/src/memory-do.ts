import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { ftsQuery, type MemoryNote, type MemoryView, type MemoryWrite } from "./memory";
import { ok, type Outcome } from "./outcome";

// One Memory Durable Object holds what every Agent in a Scope remembers about one User: a head row with
// the Profile as JSON and an FTS5 table of Notes. The Durable Object is single-writer, so a `remember`
// followed by a `recall` in the same Turn always sees the Note.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_head (scope_id TEXT NOT NULL, user_id TEXT NOT NULL, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(text, agent_id UNINDEXED, created_at UNINDEXED);
`;

type HeadRow = { scope_id: string; user_id: string; profile_json: string; updated_at: number };
type NoteRow = { id: number; text: string; agent_id: string; created_at: number };

// The decode point for the one JSON column this Durable Object writes.
const decodeProfile = (json: string): Record<string, unknown> => JSON.parse(json);

/**
 * The Durable Object behind one User's Memory in a Scope. Every method returns an Outcome; the Thread
 * Durable Object and `scope.users.memory` are its callers.
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

  // Every entry point calls this first. The head row appears on first use.
  private enter(scope: ScopeId, user: string): HeadRow {
    let head = this.sql.exec<HeadRow>("SELECT * FROM memory_head").toArray()[0];
    if (!head) {
      head = { scope_id: scope, user_id: user, profile_json: "{}", updated_at: this.deployment.clock.now() };
      this.sql.exec(
        "INSERT INTO memory_head (scope_id, user_id, profile_json, updated_at) VALUES (?, ?, ?, ?)",
        head.scope_id,
        head.user_id,
        head.profile_json,
        head.updated_at,
      );
    } else if (head.scope_id !== scope || head.user_id !== user) {
      // Only a keys.ts bug can get here. Refusing keeps it from becoming a cross-User bug.
      throw new Error(`Memory for "${head.scope_id}/${head.user_id}" was addressed as "${scope}/${user}".`);
    }
    return head;
  }

  /** The Profile and the `limit` most recent Notes. */
  get(scope: ScopeId, user: string, limit: number): Outcome<MemoryView> {
    const head = this.enter(scope, user);
    const rows = this.sql
      .exec<NoteRow>("SELECT rowid AS id, text, agent_id, created_at FROM notes ORDER BY rowid DESC LIMIT ?", limit)
      .toArray();
    return ok({ profile: decodeProfile(head.profile_json), notes: rows.map(note) });
  }

  /**
   * Merges `write.profile` into the Profile field by field, removing fields set to `null`, and appends
   * `write.note` when present. The caller has validated the fields against the Agent's schema.
   */
  remember(scope: ScopeId, user: string, write: MemoryWrite): Outcome<{ noteId?: number }> {
    const head = this.enter(scope, user);
    const now = this.deployment.clock.now();
    let noteId: number | undefined;
    this.ctx.storage.transactionSync(() => {
      if (write.profile) {
        const profile = decodeProfile(head.profile_json);
        for (const [field, value] of Object.entries(write.profile)) {
          if (value === null) delete profile[field];
          else profile[field] = value;
        }
        this.sql.exec("UPDATE memory_head SET profile_json = ?, updated_at = ?", JSON.stringify(profile), now);
      }
      if (write.note !== undefined) {
        this.sql.exec("INSERT INTO notes (text, agent_id, created_at) VALUES (?, ?, ?)", write.note, write.agent, now);
        noteId = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
      }
    });
    return ok(noteId === undefined ? {} : { noteId });
  }

  /** The Notes matching `query` by full-text search, best match first. Empty for a blank query. */
  recall(scope: ScopeId, user: string, query: string, limit: number): Outcome<MemoryNote[]> {
    this.enter(scope, user);
    const match = ftsQuery(query);
    if (match === undefined) return ok([]);
    const rows = this.sql
      .exec<NoteRow>(
        `SELECT rowid AS id, text, agent_id, created_at FROM notes
        WHERE notes MATCH ? ORDER BY bm25(notes), rowid DESC LIMIT ?`,
        match,
        limit,
      )
      .toArray();
    return ok(rows.map(note));
  }

  /** Removes the Profile and every Note. */
  clear(scope: ScopeId, user: string): Outcome<void> {
    this.enter(scope, user);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE memory_head SET profile_json = '{}', updated_at = ?", this.deployment.clock.now());
      this.sql.exec("DELETE FROM notes");
    });
    return ok(undefined);
  }
}

function note(row: NoteRow): MemoryNote {
  return { id: row.id, text: row.text, agent: row.agent_id, at: row.created_at };
}
