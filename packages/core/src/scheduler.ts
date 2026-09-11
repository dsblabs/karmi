import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings.js";
import type { Clock } from "./clock.js";
import type { Deployment } from "./deployment.js";

export type JobKind = "watchdog" | "park-timeout" | "schedule" | "scope-maintenance" | "delivery";
export interface ScheduledJob {
  id: string;
  kind: JobKind;
  dueAt: number;
  payload: unknown;
  /** Dispatch attempts of this job, independent of the Thread Step attempt budget. */
  attempt: number;
}
type JobRow = Omit<ScheduledJob, "payload"> & { payload: string; generation: string };

/** Owns the single alarm; handlers may replace their own job without losing the replacement. */
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
        // Another handler or incoming RPC may have cancelled/replaced a selected job while we yielded.
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
            payload: JSON.parse(job.payload) as unknown,
            attempt: current.attempt,
          });
        } catch (error) {
          // Keep failed work durable without a hot alarm loop; a replacement belongs to its caller.
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

/** Shared alarm ownership for Thread and ScopeConfig; job kinds stay internal to the Framework. */
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

  protected async runJob(job: ScheduledJob): Promise<void> {
    throw new Error(`Job kind "${job.kind}" is not implemented by this Durable Object.`);
  }
}
