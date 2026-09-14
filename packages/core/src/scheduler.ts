import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings";
import type { Clock } from "./clock";
import type { Deployment } from "./deployment";

/** The kinds of durable alarm job a Durable Object can schedule. Each is handled by the object that owns it. */
export type JobKind =
  | "delegation"
  | "delegation-notify"
  | "delegation-deadline"
  | "thread-cleanup"
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
type JobRow = Omit<ScheduledJob, "payload"> & { payload: string; generation: string };

/**
 * The job table behind a Durable Object's single alarm. A handler may replace or cancel its own job
 * while running, and the replacement survives the run.
 */
class Scheduler {
  constructor(
    private storage: DurableObjectStorage,
    private clock: () => Clock,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, dueAt INTEGER NOT NULL, payload TEXT NOT NULL, attempt INTEGER NOT NULL, generation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs (dueAt, id);`);
  }

  set(job: Omit<ScheduledJob, "attempt">): void {
    this.storage.sql.exec(
      "INSERT INTO jobs (id, kind, dueAt, payload, attempt, generation) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, dueAt = excluded.dueAt, payload = excluded.payload, attempt = 0, generation = excluded.generation",
      job.id,
      job.kind,
      job.dueAt,
      JSON.stringify(job.payload),
      crypto.randomUUID(),
    );
    this.rearm();
  }

  cancel(id: string): void {
    this.storage.sql.exec("DELETE FROM jobs WHERE id = ?", id);
    this.rearm();
  }

  async run(handler: (job: ScheduledJob) => Promise<void>): Promise<void> {
    const due = this.storage.sql
      .exec<JobRow>("SELECT * FROM jobs WHERE dueAt <= ? ORDER BY dueAt, id LIMIT 100", this.clock().now())
      .toArray();
    try {
      for (const job of due) {
        // The generation check skips a job that a handler or an incoming RPC cancelled or replaced
        // after the due list was read.
        const current = this.storage.sql
          .exec<{ attempt: number }>(
            "UPDATE jobs SET attempt = attempt + 1 WHERE id = ? AND generation = ? RETURNING attempt",
            job.id,
            job.generation,
          )
          .toArray()[0];
        if (!current) continue;
        try {
          await handler({
            id: job.id,
            kind: job.kind,
            dueAt: job.dueAt,
            payload: JSON.parse(job.payload),
            attempt: current.attempt,
          });
        } catch (error) {
          // A failed job is pushed one second out rather than deleted, so it stays durable without
          // re-arming the alarm in a tight loop.
          this.storage.sql.exec(
            "UPDATE jobs SET dueAt = ? WHERE id = ? AND generation = ?",
            this.clock().now() + 1000,
            job.id,
            job.generation,
          );
          throw error;
        }
        this.storage.sql.exec("DELETE FROM jobs WHERE id = ? AND generation = ?", job.id, job.generation);
      }
    } finally {
      this.rearm();
    }
  }

  private rearm(): void {
    const next = this.storage.sql
      .exec<{ dueAt: number }>("SELECT dueAt FROM jobs ORDER BY dueAt, id LIMIT 1")
      .toArray()[0];
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
  }

  alarm(): Promise<void> {
    return this.scheduler.run((job) => this.runJob(job));
  }

  /** Handles one due job. A subclass overrides it for the job kinds it owns. */
  protected async runJob(job: ScheduledJob): Promise<void> {
    throw new Error(`Job kind "${job.kind}" is not implemented by this Durable Object.`);
  }
}
