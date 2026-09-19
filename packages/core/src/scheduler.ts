import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, lte } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { KarmiBindings } from "./bindings";
import type { Clock } from "./clock";
import { alarms } from "./db/scheduler-schema";
import type { Deployment } from "./deployment";

/** The kinds of Alarm a Durable Object can schedule. Each is handled by the object that owns it. */
export type AlarmKind =
  | "usage"
  | "delegation"
  | "delegation-notify"
  | "delegation-deadline"
  | "thread-cleanup"
  | "container-watchdog"
  | "container-idle"
  | "watchdog"
  | "park-timeout"
  | "schedule"
  | "scope-maintenance"
  | "delivery";
/** One scheduled Alarm as it is handed to its handler. */
export interface ScheduledAlarm {
  id: string;
  kind: AlarmKind;
  /** When the Alarm is due, as epoch milliseconds. */
  dueAt: number;
  payload: unknown;
  /**
   * How many times this Alarm has been dispatched, counting this one. It is unrelated to the Step attempt
   * budget.
   */
  attempt: number;
}
const schedulerSchema = { alarms };

/**
 * The timed entries behind a Durable Object's single alarm. A handler may replace or cancel its own entry
 * while running, and the replacement survives the run.
 */
class Scheduler {
  private readonly db: DrizzleSqliteDODatabase<typeof schedulerSchema>;

  constructor(
    private storage: DurableObjectStorage,
    private clock: () => Clock,
  ) {
    this.db = drizzle(storage, { schema: schedulerSchema });
  }

  set(alarm: Omit<ScheduledAlarm, "attempt">): void {
    const values = { ...alarm, attempt: 0, generation: crypto.randomUUID() };
    this.db
      .insert(alarms)
      .values(values)
      .onConflictDoUpdate({
        target: alarms.id,
        set: {
          kind: values.kind,
          dueAt: values.dueAt,
          payload: values.payload,
          attempt: values.attempt,
          generation: values.generation,
        },
      })
      .run();
    this.rearm();
  }

  cancel(id: string): void {
    this.db.delete(alarms).where(eq(alarms.id, id)).run();
    this.rearm();
  }

  async run(handler: (alarm: ScheduledAlarm) => Promise<void>): Promise<void> {
    const due = this.db
      .select()
      .from(alarms)
      .where(lte(alarms.dueAt, this.clock().now()))
      .orderBy(asc(alarms.dueAt), asc(alarms.id))
      .limit(100)
      .all();
    try {
      for (const alarm of due) {
        // The generation check skips an Alarm that a handler or an incoming RPC cancelled or replaced
        // after the due list was read.
        const current = this.db
          .update(alarms)
          .set({ attempt: alarm.attempt + 1 })
          .where(and(eq(alarms.id, alarm.id), eq(alarms.generation, alarm.generation)))
          .returning({ attempt: alarms.attempt })
          .get();
        if (!current) continue;
        try {
          await handler({
            id: alarm.id,
            kind: alarm.kind,
            dueAt: alarm.dueAt,
            payload: alarm.payload,
            attempt: current.attempt,
          });
        } catch (error) {
          // A failed Alarm is pushed one second out rather than deleted, so it stays durable without
          // re-arming the alarm in a tight loop.
          this.db
            .update(alarms)
            .set({ dueAt: this.clock().now() + 1000 })
            .where(and(eq(alarms.id, alarm.id), eq(alarms.generation, alarm.generation)))
            .run();
          throw error;
        }
        this.db
          .delete(alarms)
          .where(and(eq(alarms.id, alarm.id), eq(alarms.generation, alarm.generation)))
          .run();
      }
    } finally {
      this.rearm();
    }
  }

  private rearm(): void {
    const next = this.db
      .select({ dueAt: alarms.dueAt })
      .from(alarms)
      .orderBy(asc(alarms.dueAt), asc(alarms.id))
      .limit(1)
      .get();
    if (next) void this.storage.setAlarm(Math.max(next.dueAt, this.clock().now()));
    else void this.storage.deleteAlarm();
  }
}

/**
 * A Durable Object whose alarm is driven by durable timed entries. The Thread and ScopeConfig objects extend it
 * and override `runAlarm` for the Alarm kinds they own.
 */
export abstract class ScheduledDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;
  protected readonly scheduler: Scheduler;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.scheduler = new Scheduler(ctx.storage, () => this.deployment.clock);
  }

  alarm(): Promise<void> {
    return this.scheduler.run((alarm) => this.runAlarm(alarm));
  }

  /** Handles one due Alarm. A subclass overrides it for the Alarm kinds it owns. */
  protected async runAlarm(alarm: ScheduledAlarm): Promise<void> {
    throw new Error(`Alarm kind "${alarm.kind}" is not implemented by this Durable Object.`);
  }
}
