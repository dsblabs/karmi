import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { errorMessage, KarmiError } from "./errors";
import { keys } from "./keys";
import type { KnowledgeDurableObject } from "./knowledge-do";
import type { MemoryDurableObject } from "./memory-do";
import { remote, unwrap } from "./outcome";
import { credentialRef, isInternalStore } from "./secrets";
import type { ThreadDurableObject } from "./thread-do";

// This module is the maintenance walk behind `scope.destroy()`. The ScopeConfig Durable Object tombstones
// the Scope in one transaction, then runs this walk on its alarm, one batch per firing, until every Thread,
// Memory, Knowledge corpus and R2 object of the Scope is gone. Every batch deletes the index rows it has
// just acted on, so a walk that stops part-way resumes from what is left.

/** How many indexed Durable Objects one batch deletes. */
const OBJECT_BATCH = 20;
/** How many R2 objects one batch deletes. */
const MEDIA_BATCH = 100;
/** How many times a batch may fail before the walk gives up on the item it is stuck on. */
const BATCH_ATTEMPTS = 5;

/**
 * The tables the tombstone transaction empties before the walk starts, so that nothing can open a
 * credential or an MCP grant of a destroying Scope.
 */
export const TOMBSTONE_TABLES = [
  "provider_credentials",
  "mcp_catalog",
  "mcp_grants",
  "mcp_clients",
  "mcp_oauth_state",
  "user_connections",
] as const;

/** The tables the last phase empties, once every store outside the Scope's own object is empty. */
const REMAINING_TABLES = [
  "container_leases",
  "scope_revisions",
  "agent_specs",
  "agent_heads",
  "connections",
  "threads",
  "thread_parents",
  "knowledge_names",
  "memory_users",
] as const;

/** The stages of the walk, in the order it runs them. */
const PHASES = ["secrets", "threads", "memory", "knowledge", "media", "config", "done"] as const;

/** What a destroy walk is deleting now. `done` means the Scope holds nothing but its tombstone. */
export type DestroyPhase = (typeof PHASES)[number];

/** How far a destroy walk has got. Every count is what it has deleted so far. */
export interface DestroyProgress {
  /** The stage the walk is in. */
  phase: DestroyPhase;
  /** The Threads deleted, Delegation children included. */
  threads: number;
  /** The Users whose Memory was deleted. */
  memory: number;
  /** The Knowledge corpora deleted, with their Retriever mirrors. */
  knowledge: number;
  /** The R2 objects deleted under the Scope's prefix. */
  objects: number;
  /** The items the walk gave up on. Anything counted here is still held by the store that refused. */
  skipped: number;
}

/**
 * What a destroy asked of a Secrets provider karmi does not own. It is absent when the Scope's credentials
 * lived in karmi's own store, which the tombstone transaction wipes.
 */
export interface ExternalCleanup {
  /** Whether the store revoked the credentials, or cannot and leaves them to the Platform. */
  secrets: "revoked" | "unsupported";
  /** The credentials the store named, empty when it cannot list them. */
  credentials: string[];
}

/** Where a destroy walk has got to. It is stored on the operation row and resumes the walk after a failure. */
export interface DestroyCursor {
  progress: DestroyProgress;
  external?: ExternalCleanup;
}

/** Everything one batch of the walk needs: the Scope it empties and the storage it reads its index from. */
export interface DestroyWalk {
  scope: ScopeId;
  deployment: Deployment;
  /** The Durable Object's own bindings, which name every store the Scope wrote to. */
  bindings: KarmiBindings;
  /** The ScopeConfig Durable Object's SQLite, which holds the Thread, Memory and Knowledge indexes. */
  sql: SqlStorage;
  /** How many times the current batch has already failed. */
  attempt: number;
}

/** The cursor a destroy operation starts from. */
export function startCursor(): DestroyCursor {
  return { progress: { phase: "secrets", threads: 0, memory: 0, knowledge: 0, objects: 0, skipped: 0 } };
}

/**
 * The cursor stored on an operation row, or a fresh one when the walk has not run yet. Only this module
 * writes the column, so decoding does not validate it again.
 */
export function decodeCursor(json: string | null): DestroyCursor {
  return json === null ? startCursor() : JSON.parse(json);
}

/**
 * Runs one batch of the walk and returns the cursor to store. The walk is over once the returned phase is
 * `done`. A batch that throws has changed nothing it has not already recorded, so the caller retries it.
 */
export async function destroyStep(walk: DestroyWalk, cursor: DestroyCursor): Promise<DestroyCursor> {
  switch (cursor.progress.phase) {
    case "secrets": {
      const external = await revokeExternal(walk);
      return { ...advance(cursor, true, {}), ...(external && { external }) };
    }
    case "threads":
      return deleteThreads(walk, cursor);
    case "memory":
      return deleteMemory(walk, cursor);
    case "knowledge":
      return deleteKnowledge(walk, cursor);
    case "media":
      return deleteMedia(walk, cursor);
    case "config":
      return deleteConfig(walk, cursor);
    case "done":
      return cursor;
  }
}

/** The cursor after a batch, moved on to the next phase when `emptied` says the phase has nothing left. */
function advance(cursor: DestroyCursor, emptied: boolean, counts: Partial<DestroyProgress>): DestroyCursor {
  const phase = emptied ? (PHASES[PHASES.indexOf(cursor.progress.phase) + 1] ?? "done") : cursor.progress.phase;
  return { ...cursor, progress: { ...cursor.progress, ...counts, phase } };
}

/**
 * Deletes what `item` names and reports whether it is gone. The alarm retries a batch that throws, so an
 * item that never succeeds would stall the walk; after `BATCH_ATTEMPTS` failures it is logged, counted as
 * skipped and left where it is.
 */
async function deleteItem(walk: DestroyWalk, item: string, action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    if (walk.attempt < BATCH_ATTEMPTS) throw error;
    walk.deployment.logger.error("Scope destroy skipped an item it could not delete", {
      scope: walk.scope,
      item,
      error: errorMessage(error),
    });
    return false;
  }
}

/**
 * Deletes every row of one batch and forgets it from the index either way, since a row the walk has given up
 * on must not be read again. It returns how many were deleted and how many were skipped.
 */
async function deleteBatch<Row>(
  walk: DestroyWalk,
  rows: Row[],
  item: (row: Row) => string,
  remove: (row: Row) => Promise<void>,
  forget: (row: Row) => void,
): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0;
  for (const row of rows) {
    if (await deleteItem(walk, item(row), () => remove(row))) deleted++;
    forget(row);
  }
  return { deleted, skipped: rows.length - deleted };
}

/** The cursor after a batch of indexed objects, with its counts folded into the progress. */
function counted(
  cursor: DestroyCursor,
  rows: number,
  batch: { deleted: number; skipped: number },
  count: "threads" | "memory" | "knowledge",
): DestroyCursor {
  return advance(cursor, rows < OBJECT_BATCH, {
    [count]: cursor.progress[count] + batch.deleted,
    skipped: cursor.progress.skipped + batch.skipped,
  });
}

async function revokeExternal(walk: DestroyWalk): Promise<ExternalCleanup | undefined> {
  const { secrets } = walk.deployment;
  // karmi's own store keeps its rows in this Durable Object, and the tombstone transaction wiped them.
  if (isInternalStore(secrets)) return undefined;
  const { list, revoke } = secrets;
  // A store without `revoke` cannot drop a credential, and one without `list` cannot say which credentials
  // to name. Either way the Platform is left to remove them.
  if (!list || !revoke) return { secrets: "unsupported", credentials: [] };
  const credentials = (await list.call(secrets, walk.scope)).map((entry) => entry.name);
  const skipped = [];
  for (const name of credentials)
    // The store is asked by reference, exactly as `scope.credentials.revoke` asks it.
    if (
      !(await deleteItem(walk, `credential ${name}`, () =>
        revoke.call(secrets, { scope: walk.scope, ref: credentialRef("scope", name) }),
      ))
    )
      skipped.push(name);
  return skipped.length > 0 ? { secrets: "unsupported", credentials: skipped } : { secrets: "revoked", credentials };
}

async function deleteThreads(walk: DestroyWalk, cursor: DestroyCursor): Promise<DestroyCursor> {
  const rows = walk.sql
    .exec<{ thread_id: string; agent_id: string; user_id: string | null }>(
      "SELECT thread_id, agent_id, user_id FROM threads ORDER BY thread_id LIMIT ?",
      OBJECT_BATCH,
    )
    .toArray();
  const batch = await deleteBatch(
    walk,
    rows,
    (row) => `thread ${row.thread_id}`,
    async (row) => {
      const stub = remote<ThreadDurableObject>(walk.bindings.KARMI_THREADS, keys.thread(walk.scope, row.thread_id));
      const deleted = await stub.delete({
        scope: walk.scope,
        threadId: row.thread_id,
        agent: row.agent_id,
        ...(row.user_id !== null && { user: row.user_id }),
        create: false,
      });
      // An indexed Thread whose object never took a Turn has nothing to delete.
      if (!deleted.ok && deleted.code !== "thread.notFound") throw new KarmiError(deleted.code, deleted.message);
    },
    (row) => {
      walk.sql.exec("DELETE FROM threads WHERE thread_id = ?", row.thread_id);
      walk.sql.exec("DELETE FROM thread_parents WHERE thread_id = ?", row.thread_id);
    },
  );
  return counted(cursor, rows.length, batch, "threads");
}

async function deleteMemory(walk: DestroyWalk, cursor: DestroyCursor): Promise<DestroyCursor> {
  const rows = walk.sql
    .exec<{ user_id: string }>("SELECT user_id FROM memory_users ORDER BY user_id LIMIT ?", OBJECT_BATCH)
    .toArray();
  const batch = await deleteBatch(
    walk,
    rows,
    (row) => `memory ${row.user_id}`,
    async (row) => {
      const stub = remote<MemoryDurableObject>(walk.bindings.KARMI_MEMORY, keys.memory(walk.scope, row.user_id));
      await unwrap(stub.clear(walk.scope, row.user_id));
    },
    (row) => void walk.sql.exec("DELETE FROM memory_users WHERE user_id = ?", row.user_id),
  );
  return counted(cursor, rows.length, batch, "memory");
}

async function deleteKnowledge(walk: DestroyWalk, cursor: DestroyCursor): Promise<DestroyCursor> {
  const rows = walk.sql
    .exec<{ name: string }>("SELECT name FROM knowledge_names ORDER BY name LIMIT ?", OBJECT_BATCH)
    .toArray();
  // Without the binding no corpus can ever have been written, so the index rows are all that is left.
  const namespace = walk.bindings.KARMI_KNOWLEDGE;
  const batch = await deleteBatch(
    walk,
    rows,
    (row) => `knowledge ${row.name}`,
    async (row) => {
      if (!namespace) return;
      const stub = remote<KnowledgeDurableObject>(namespace, keys.knowledge(walk.scope, row.name));
      await unwrap(stub.destroy(walk.scope, row.name, "scope-destroy"));
    },
    (row) => void walk.sql.exec("DELETE FROM knowledge_names WHERE name = ?", row.name),
  );
  return counted(cursor, rows.length, batch, "knowledge");
}

async function deleteMedia(walk: DestroyWalk, cursor: DestroyCursor): Promise<DestroyCursor> {
  const bucket = walk.bindings.KARMI_MEDIA;
  if (!bucket) return advance(cursor, true, {});
  const listed = await bucket.list({ prefix: keys.r2Prefix(walk.scope), limit: MEDIA_BATCH });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
  return advance(cursor, !listed.truncated, { objects: cursor.progress.objects + listed.objects.length });
}

/**
 * Empties the Scope's own Durable Object. Only the tombstone and the destroy operations stay, so the
 * ScopeId can never be used again.
 */
function deleteConfig(walk: DestroyWalk, cursor: DestroyCursor): DestroyCursor {
  for (const table of REMAINING_TABLES) walk.sql.exec(`DELETE FROM ${table}`);
  return advance(cursor, true, {});
}
