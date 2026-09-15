import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import type { Capabilities } from "./agent";
import { isMediaRef, MediaRefSchema } from "./context";
import { defineFragment } from "./fragment";
import type { ThreadAddress } from "./thread";
import type { Budget, ThreadEvent, TurnInput } from "./thread-events";
import { errorResult, type Tool, type ToolResult } from "./tool";

/** The delegating Thread and the `delegate` call that opened a child Thread. */
export interface ParentLink {
  threadKey: string;
  /** The `ToolContext.callId` of the `delegate` call, stable across re-runs. */
  callId: string;
}
/** One Thread above a child in the Delegation chain, with the limits and deadline it imposes. */
export interface Ancestor {
  address: ThreadAddress;
  /** The ancestor's Turn during which the Delegation started. */
  turn: number;
  /** The ancestor's resolved `delegation` Capability. */
  limits: NonNullable<Capabilities["delegation"]>;
  /** The epoch milliseconds by which the ancestor's Turn must end. */
  deadline: number;
}
/** Where a child Thread comes from: its direct parent and every ancestor up to the root. */
export interface ChildOrigin {
  parent: ParentLink;
  /** Ancestors from the root down to the direct parent. */
  chain: Ancestor[];
}
/** The durable state of one child Thread as its parent tracks it. */
export interface DelegationRecord {
  /** The `delegate` call id, which is also the Job id the parent's tool Step waits on. */
  id: string;
  /** The parent's Turn that started the child. */
  turn: number;
  address: ThreadAddress;
  origin: ChildOrigin;
  /** The Turn input the child runs. */
  input: TurnInput;
  /** The child's last log `seq` the parent has read. */
  after: number;
  /** Whether the child has been counted against every ancestor's concurrency and child limits. */
  reserved: boolean;
  /** Whether the child's Turn has been sent. */
  started: boolean;
  /** Whether the child's Turn has ended. */
  done: boolean;
  /** Whether the child's reservation has been released on every ancestor. */
  released: boolean;
}
const decodeRecord = (json: string): DelegationRecord => JSON.parse(json);
const decodeOrigin = (json: string): ChildOrigin => JSON.parse(json);

/**
 * The parent Thread's persisted record of its children, origin and reservations. Because starts and cursors are
 * durable, a re-run of the tool Step never queues a second child Turn.
 */
export class DelegationStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS delegation_origin (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_children (id TEXT PRIMARY KEY, turn INTEGER NOT NULL, released INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_children_outstanding ON delegation_children (released) WHERE released = 0;
      CREATE INDEX IF NOT EXISTS delegation_children_by_turn ON delegation_children (turn);
      CREATE TABLE IF NOT EXISTS delegation_reservations (id TEXT PRIMARY KEY, turn INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_reservations_by_turn ON delegation_reservations (turn);`);
  }
  origin(): ChildOrigin | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM delegation_origin WHERE id = 1").toArray()[0];
    return row && decodeOrigin(row.json);
  }
  attach(origin: ChildOrigin): boolean {
    if (this.origin()) return false;
    this.sql.exec("INSERT INTO delegation_origin (id, json) VALUES (1, ?)", JSON.stringify(origin));
    return true;
  }
  child(id: string): DelegationRecord | undefined {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM delegation_children WHERE id = ?", id).toArray()[0];
    return row && decodeRecord(row.json);
  }
  children(turn?: number): DelegationRecord[] {
    const rows =
      turn === undefined
        ? this.sql.exec<{ json: string }>("SELECT json FROM delegation_children")
        : this.sql.exec<{ json: string }>("SELECT json FROM delegation_children WHERE turn = ?", turn);
    return rows.toArray().map((row) => decodeRecord(row.json));
  }
  outstanding(): DelegationRecord[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM delegation_children WHERE released = 0")
      .toArray()
      .map((row) => decodeRecord(row.json));
  }
  save(record: DelegationRecord): void {
    this.sql.exec(
      "INSERT INTO delegation_children (id, turn, released, json) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, released = excluded.released",
      record.id,
      record.turn,
      record.released ? 1 : 0,
      JSON.stringify(record),
    );
  }
  reserve(id: string, ancestor: Ancestor): string | undefined {
    if (this.sql.exec("SELECT id FROM delegation_reservations WHERE id = ?", id).toArray().length) return;
    const counts = this.budget(ancestor.turn);
    if (counts.children >= (ancestor.limits.maxChildren ?? AGENT_SPEC_DEFAULTS.delegation.maxChildren))
      return "maxChildren";
    if (counts.active >= (ancestor.limits.maxConcurrent ?? AGENT_SPEC_DEFAULTS.delegation.maxConcurrent))
      return "maxConcurrent";
    this.sql.exec("INSERT INTO delegation_reservations (id, turn, active) VALUES (?, ?, 1)", id, ancestor.turn);
  }
  release(id: string, rollback: boolean): void {
    if (rollback) this.sql.exec("DELETE FROM delegation_reservations WHERE id = ?", id);
    else this.sql.exec("UPDATE delegation_reservations SET active = 0 WHERE id = ?", id);
  }
  budget(turn: number): { children: number; active: number } {
    const row = this.sql
      .exec<{ children: number; active: number }>(
        "SELECT COUNT(*) AS children, COALESCE(SUM(active), 0) AS active FROM delegation_reservations WHERE turn = ?",
        turn,
      )
      .one();
    return row;
  }
}

const DelegateInput = z.object({
  agent: z.string(),
  task: z.string(),
  attachments: z.optional(z.array(MediaRefSchema)),
});
/** The input of the built-in `delegate` Tool: the Agent to run, the task text and optional attachments. */
export type DelegateInput = z.output<typeof DelegateInput>;
/**
 * Builds the built-in `delegate` Tool for one Agent. `agents` are the Agents it may name. `execute` starts the
 * child and returns either the result or `{ pending }` to park the tool Step until the child finishes.
 */
export function delegateTool(
  agents: string[],
  execute: (input: DelegateInput, callId: string) => Promise<{ pending: string } | ToolResult>,
): Tool<typeof DelegateInput, undefined> {
  return {
    kind: "tool",
    name: "delegate",
    description: "Starts a fresh child Thread with an allowed Agent and waits for its final answer.",
    input: DelegateInput,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    instructions: defineFragment({
      name: "delegation-agents",
      render: () => `Allowed Agents for delegation:\n${agents.map((agent) => `- ${agent}`).join("\n")}`,
    }),
    execute: (input, ctx) => execute(input, ctx.callId),
  };
}
/** Wraps `message` as an error Tool result. */
export function delegationError(message: string): ToolResult {
  return errorResult(message);
}
/**
 * Converts a child's final `turn.completed` or `turn.failed` event into the parent's Tool result. Text and media
 * blocks are kept. A failed Turn or a budget stop becomes an error result.
 */
export function delegationResult(event: Extract<ThreadEvent, { type: "turn.completed" | "turn.failed" }>): ToolResult {
  if (event.type === "turn.failed") return delegationError(`${event.reason}: ${event.message}`);
  const content = event.message.flatMap((block): ToolResult["content"] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if ("media" in block && isMediaRef(block.media)) return [{ type: "media", media: block.media }];
    return [];
  });
  return { content, isError: event.stopReason === "budget" };
}
/**
 * Whether delegating to `agent` from the end of `chain` would exceed an ancestor's `maxDepth` or re-enter an
 * ancestor Agent.
 */
export function depthLimit(chain: Ancestor[], agent: string): boolean {
  return chain.some(
    (ancestor, index) =>
      ancestor.address.agent === agent ||
      chain.length - index > (ancestor.limits.maxDepth ?? AGENT_SPEC_DEFAULTS.delegation.maxDepth),
  );
}
/**
 * The epoch milliseconds by which a new child must finish: the parent's remaining wall budget, capped by
 * every ancestor's deadline.
 */
export function delegationDeadline(now: number, budget: Budget, spent: Budget, chain: Ancestor[]): number {
  return Math.min(now + Math.max(0, budget.wallMs - spent.wallMs), ...chain.map((a) => a.deadline));
}

/** Fills a `delegation` grant with defaults and caps each limit by the Scope ceiling, when there is one. */
export function resolveDelegationLimits(
  grant: NonNullable<Capabilities["delegation"]>,
  ceiling: false | NonNullable<Capabilities["delegation"]> | undefined,
): NonNullable<Capabilities["delegation"]> {
  const max = ceiling || {};
  return {
    maxDepth: Math.min(
      grant.maxDepth ?? AGENT_SPEC_DEFAULTS.delegation.maxDepth,
      max.maxDepth ?? Number.MAX_SAFE_INTEGER,
    ),
    maxConcurrent: Math.min(
      grant.maxConcurrent ?? AGENT_SPEC_DEFAULTS.delegation.maxConcurrent,
      max.maxConcurrent ?? Number.MAX_SAFE_INTEGER,
    ),
    maxChildren: Math.min(
      grant.maxChildren ?? AGENT_SPEC_DEFAULTS.delegation.maxChildren,
      max.maxChildren ?? Number.MAX_SAFE_INTEGER,
    ),
  };
}
