import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS } from "./agent-spec";
import type { Capabilities } from "./agent";
import { isMediaRef, MediaRefSchema } from "./context";
import { defineFragment } from "./fragment";
import type { ThreadAddress } from "./thread";
import type { Budget, ThreadEvent, TurnInput } from "./thread-events";
import type { Tool, ToolResult } from "./tool";

export interface ParentLink {
  threadKey: string;
  callId: string;
}
export interface Ancestor {
  address: ThreadAddress;
  turn: number;
  limits: NonNullable<Capabilities["delegation"]>;
  deadline: number;
}
export interface ChildOrigin {
  parent: ParentLink;
  chain: Ancestor[];
}
export interface DelegationRecord {
  id: string;
  turn: number;
  address: ThreadAddress;
  origin: ChildOrigin;
  input: TurnInput;
  after: number;
  reserved: boolean;
  started: boolean;
  done: boolean;
  released: boolean;
}
const decodeRecord = (json: string): DelegationRecord => JSON.parse(json);
const decodeOrigin = (json: string): ChildOrigin => JSON.parse(json);

/** Durable child starts and cursors: replay never queues a second child Turn. */
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
export type DelegateInput = z.output<typeof DelegateInput>;
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
export function delegationError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
export function delegationResult(event: Extract<ThreadEvent, { type: "turn.completed" | "turn.failed" }>): ToolResult {
  if (event.type === "turn.failed") return delegationError(`${event.reason}: ${event.message}`);
  const content = event.message.flatMap((block): ToolResult["content"] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if ("media" in block && isMediaRef(block.media)) return [{ type: "media", media: block.media }];
    return [];
  });
  return { content, isError: event.stopReason === "budget" };
}
export function depthLimit(chain: Ancestor[], agent: string): boolean {
  return chain.some(
    (ancestor, index) =>
      ancestor.address.agent === agent ||
      chain.length - index > (ancestor.limits.maxDepth ?? AGENT_SPEC_DEFAULTS.delegation.maxDepth),
  );
}
export function delegationDeadline(now: number, budget: Budget, spent: Budget, chain: Ancestor[]): number {
  return Math.min(now + Math.max(0, budget.wallMs - spent.wallMs), ...chain.map((a) => a.deadline));
}

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
