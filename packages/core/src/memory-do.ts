import { DurableObject } from "cloudflare:workers";
import { desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import memoryMigrations from "./db/memory/migrations";
import { notes } from "./db/memory/notes";
import { memoryHead, memorySchema, vectorIds, vectors } from "./db/memory/schema";
import type { Deployment } from "./deployment";
import { ftsQuery, RECALL_LIMIT, type MemoryNote, type MemoryView, type MemoryWrite } from "./memory";
import { ok, type Outcome } from "./outcome";

type MemoryHead = typeof memoryHead.$inferSelect;
type NoteRow = typeof notes.$inferSelect;

/**
 * The Durable Object behind one User's Memory in a Scope. Every method returns an Outcome. The Thread
 * Durable Object and `scope.users.memory` are its only callers.
 */
export abstract class MemoryDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;
  private readonly db;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: memorySchema });
    ctx.blockConcurrencyWhile(() => migrate(this.db, memoryMigrations));
  }

  // Returns the head row, or undefined before the first write. A read never creates one, so reading a
  // User who has no Memory leaves no storage behind.
  private loadHead(scope: ScopeId, user: string): MemoryHead | undefined {
    const head = this.db.select().from(memoryHead).get();
    // Only a keys.ts bug can address one User's object as another. Refusing keeps it from leaking Memory.
    if (head && (head.scopeId !== scope || head.userId !== user))
      throw new Error(`Memory for "${head.scopeId}/${head.userId}" was addressed as "${scope}/${user}".`);
    return head;
  }

  /** Returns the Profile and the `limit` most recent Notes. */
  get(scope: ScopeId, user: string, limit: number): Outcome<MemoryView> {
    const head = this.loadHead(scope, user);
    if (!head) return ok({ profile: {}, notes: [] });
    const rows = this.db.select().from(notes).orderBy(desc(notes.id)).limit(limit).all();
    return ok({ profile: decodeProfile(head.profile), notes: rows.map(toNote) });
  }

  /**
   * Merges `write.profile` into the Profile field by field, removing fields set to `null`, and appends
   * `write.note` when present. The caller has already checked the fields against the Agent's schema.
   */
  remember(scope: ScopeId, user: string, write: MemoryWrite): Outcome<void> {
    const now = this.deployment.clock.now();
    const current = this.loadHead(scope, user);
    this.db.transaction((tx) => {
      const profile = decodeProfile(current?.profile ?? {});
      for (const [field, value] of Object.entries(write.profile ?? {})) {
        if (value === null) delete profile[field];
        else profile[field] = value;
      }
      tx.delete(memoryHead).run();
      tx.insert(memoryHead).values({ scopeId: scope, userId: user, profile, updatedAt: now }).run();
      if (write.note !== undefined)
        tx.insert(notes).values({ text: write.note, agentId: write.agent, createdAt: now }).run();
    });
    return ok(undefined);
  }

  /** Returns the Notes matching `query` by full-text search, best match first. A blank query matches none. */
  recall(scope: ScopeId, user: string, query: string): Outcome<MemoryNote[]> {
    const match = ftsQuery(query);
    if (!this.loadHead(scope, user) || match === undefined) return ok([]);
    const rows = this.db.all<NoteRow>(
      sql`SELECT rowid AS id, text, agent_id AS agentId, created_at AS createdAt FROM notes
          WHERE notes MATCH ${match} ORDER BY bm25(notes), rowid DESC LIMIT ${RECALL_LIMIT}`,
    );
    return ok(rows.map(toNote));
  }

  /** Deletes the Profile, every Note and every vector owned by this Memory. */
  async clear(scope: ScopeId, user: string): Promise<Outcome<void>> {
    this.loadHead(scope, user);
    this.db.transaction((tx) => {
      tx.delete(notes).run();
      tx.delete(vectorIds).run();
      tx.delete(vectors).run();
      tx.delete(memoryHead).run();
    });
    return ok(undefined);
  }
}

function toNote(row: NoteRow): MemoryNote {
  return { id: row.id, text: row.text, agent: row.agentId, at: row.createdAt };
}

function decodeProfile(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The stored Memory Profile is not an object.");
  return Object.fromEntries(Object.entries(value));
}
