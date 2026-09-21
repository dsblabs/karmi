import { asc, eq, lte } from "drizzle-orm";
import type { ThreadDatabase } from "./db/thread/database";
import { inputs } from "./db/thread/schema";
import type { TurnInput } from "./thread-events";

// This is the only decode point for the stored inputs. The rows are the Thread's own, so the shape is trusted.
const decodeInput = (value: TurnInput): TurnInput => value;

/**
 * The Turn inputs of one Thread that wait for a Turn, in the order of their arrival. An input waits for the
 * Turn with its number, or as a steer input for the Turn in progress. The queue never starts a Turn. Each
 * `take` reads and removes in one synchronous step, so the caller must log the result before it yields.
 */
export class InputQueue {
  constructor(private db: ThreadDatabase) {}

  /** Adds `input` for `turn` and returns its id. A steer input joins that Turn at its next batch boundary. */
  add(turn: number, input: TurnInput, steer: boolean): number {
    return this.db.insert(inputs).values({ turn, input, steer }).returning({ id: inputs.id }).get().id;
  }

  /** Whether the input with `id` still waits. */
  has(id: number): boolean {
    return this.db.select({ id: inputs.id }).from(inputs).where(eq(inputs.id, id)).get() !== undefined;
  }

  /** Whether no input waits. */
  isEmpty(): boolean {
    return this.db.select({ id: inputs.id }).from(inputs).get() === undefined;
  }

  /** The oldest waiting input, which stays in the queue. */
  first(): TurnInput | undefined {
    const row = this.db.select({ input: inputs.input }).from(inputs).orderBy(asc(inputs.id)).get();
    return row && decodeInput(row.input);
  }

  /** Removes and returns every input for `turn` or a Turn before it, oldest first. */
  takeThrough(turn: number): TurnInput[] {
    const rows = this.db
      .select({ input: inputs.input })
      .from(inputs)
      .where(lte(inputs.turn, turn))
      .orderBy(asc(inputs.id))
      .all();
    if (rows.length) this.db.delete(inputs).where(lte(inputs.turn, turn)).run();
    return rows.map((row) => decodeInput(row.input));
  }

  /** Removes and returns every steer input, oldest first. */
  takeSteers(): TurnInput[] {
    const rows = this.db
      .select({ input: inputs.input })
      .from(inputs)
      .where(eq(inputs.steer, true))
      .orderBy(asc(inputs.id))
      .all();
    if (rows.length) this.db.delete(inputs).where(eq(inputs.steer, true)).run();
    return rows.map((row) => decodeInput(row.input));
  }

  /** Removes every waiting input. */
  clear(): void {
    this.db.delete(inputs).run();
  }
}
