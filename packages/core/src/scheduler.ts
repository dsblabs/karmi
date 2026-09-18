import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, lte } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { KarmiBindings } from "./bindings";
import type { Clock } from "./clock";
import schedulerMigrations from "./db/scheduler/migrations";
import { jobs } from "./db/scheduler/schema";
import type { Deployment } from "./deployment";

/** The kinds of durable alarm job a Durable Object can schedule. Each is handled by the object that owns it. */
export type JobKind =
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
/** One durable alarm job as it is handed to its handler. */
export interface ScheduledJob {
  id: string;
  kind: JobKind;
  /** When the job is due, as epoch milliseconds. */
  dueAt: number;
  payload: unknown;
  /**
   * How many times this job has been dispatched, counting this one. It is unrelated to the Step attempt
   * budget.
   */
  attempt: number;
}
const schedulerSchema = { jobs };

/**
 * The job table behind a Durable Object's single alarm. A handler may replace or cancel its own job
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

  migrate(): Promise<void> {
    return migrate(this.db, schedulerMigrations);
  }

  set(job: Omit<ScheduledJob, "attempt">): void {
    const values = { ...job, attempt: 0, generation: crypto.randomUUID() };
    this.db
      .insert(jobs)
      .values(values)
      .onConflictDoUpdate({
        target: jobs.id,
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
    this.db.delete(jobs).where(eq(jobs.id, id)).run();
    this.rearm();
  }

  async run(handler: (job: ScheduledJob) => Promise<void>): Promise<void> {
    const due = this.db
      .select()
      .from(jobs)
      .where(lte(jobs.dueAt, this.clock().now()))
      .orderBy(asc(jobs.dueAt), asc(jobs.id))
      .limit(100)
      .all();
    try {
      for (const job of due) {
        // The generation check skips a job that a handler or an incoming RPC cancelled or replaced
        // after the due list was read.
        const current = this.db
          .update(jobs)
          .set({ attempt: job.attempt + 1 })
          .where(and(eq(jobs.id, job.id), eq(jobs.generation, job.generation)))
          .returning({ attempt: jobs.attempt })
          .get();
        if (!current) continue;
        try {
          await handler({
            id: job.id,
            kind: job.kind,
            dueAt: job.dueAt,
            payload: job.payload,
            attempt: current.attempt,
          });
        } catch (error) {
          // A failed job is pushed one second out rather than deleted, so it stays durable without
          // re-arming the alarm in a tight loop.
          this.db
            .update(jobs)
            .set({ dueAt: this.clock().now() + 1000 })
            .where(and(eq(jobs.id, job.id), eq(jobs.generation, job.generation)))
            .run();
          throw error;
        }
        this.db
          .delete(jobs)
          .where(and(eq(jobs.id, job.id), eq(jobs.generation, job.generation)))
          .run();
      }
    } finally {
      this.rearm();
    }
  }

  private rearm(): void {
    const next = this.db.select({ dueAt: jobs.dueAt }).from(jobs).orderBy(asc(jobs.dueAt), asc(jobs.id)).limit(1).get();
    if (next) void this.storage.setAlarm(Math.max(next.dueAt, this.clock().now()));
    else void this.storage.deleteAlarm();
  }
}

/**
 * A Durable Object whose alarm is driven by a job table. The Thread and ScopeConfig objects extend it
 * and override `runJob` for the job kinds they own.
 */
export abstract class ScheduledDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;
  protected readonly scheduler: Scheduler;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.scheduler = new Scheduler(ctx.storage, () => this.deployment.clock);
    ctx.blockConcurrencyWhile(() => this.scheduler.migrate());
  }

  alarm(): Promise<void> {
    return this.scheduler.run((job) => this.runJob(job));
  }

  /** Handles one due job. A subclass overrides it for the job kinds it owns. */
  protected async runJob(job: ScheduledJob): Promise<void> {
    throw new Error(`Job kind "${job.kind}" is not implemented by this Durable Object.`);
  }
}
