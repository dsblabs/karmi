import { eq } from "drizzle-orm";
import { CloudflareContainerSandbox } from "./container-sandbox";
import type { ContainerDriver, ContainerLimits, ContainerRun } from "./container-types";
import type { Logger } from "./context";
import type { ThreadDatabase } from "./db/thread/database";
import { containerRuns, containerWorkspaces } from "./db/thread/schema";
import { errorMessage, KarmiError } from "./errors";
import { threadMayRead } from "./keys";
import { DEFAULT_MEDIA_BYTES, putMedia } from "./media";
import type { Outcome } from "./outcome";
import type { SandboxRequest, SandboxResult } from "./sandbox";
import type { Scheduler } from "./scheduler";
import type { ScopeConfigDocument } from "./scope-config";
import type { ThreadEventData } from "./thread-events";
import type { ToolPending } from "./tool";

const WATCHDOG_MS = 5000;
// A Cloudflare Sandbox Durable Object can reset while it destroys its container. The call then fails or hangs
// for a minute, thus the Workspace stops waiting after this time and tries again after the retry time.
const DESTROY_WAIT_MS = 10_000;
/** The time after which the Workspace or the Thread cleanup tries a failed container destroy again. */
export const DESTROY_RETRY_MS = 30_000;

/** The container settings of the current Turn snapshot. */
export interface WorkspaceTurn {
  limits: ContainerLimits;
  media: ScopeConfigDocument["media"];
  allow: string[];
}

/** The Thread resources that the Workspace uses. None of them reach the process in the container. */
export interface WorkspaceHost {
  db: ThreadDatabase;
  scheduler: Scheduler;
  scope: string;
  threadId: string;
  bucket: R2Bucket | undefined;
  now(): number;
  logger: Logger;
  /** Returns the container runtime of this Thread, or undefined when the Deployment has none. */
  driver(): ContainerDriver | undefined;
  /** Returns the container settings of the current Turn, or undefined when it has no container Scripts. */
  turn(): WorkspaceTurn | undefined;
  reserve(): Promise<Outcome<void>>;
  release(): Promise<Outcome<void>>;
  /** Tells if a Turn step runs now. A step polls its own process, so the watchdog waits. */
  busy(): boolean;
  hasStartedJob(jobId: string): boolean;
  /** Returns the id of the open Job for the process, or undefined when no Job waits for it. */
  pendingJob(processId: string): string | undefined;
  append(event: ThreadEventData): void;
  /** Appends the terminal event of a Job. The Workspace calls it inside its write transaction. */
  recordJob(jobId: string, result: SandboxResult): void;
}

/**
 * Owns the container Workspace of one Thread: the Scope slot, the process record, and the idle and watchdog
 * alarms. The Thread decides when a Turn ends and calls `destroy()`. The Workspace never ends a Turn.
 */
export class ThreadWorkspace {
  constructor(private readonly host: WorkspaceHost) {}

  /** Runs a Script. It reserves the Scope slot first, and it arms the idle alarm when the Script finishes. */
  async run(request: SandboxRequest): Promise<SandboxResult | ToolPending> {
    const turn = this.host.turn();
    const sandbox = turn && this.sandbox(turn);
    if (!turn || !sandbox) throw new Error("Container Scripts require KARMI_SANDBOX and sandbox.image.");
    // Persist cleanup intent before the remote reservation so eviction cannot leak a Scope slot.
    this.host.db.insert(containerWorkspaces).values({ id: 1 }).onConflictDoNothing().run();
    this.host.scheduler.cancel("container-idle");
    const reserved = await this.host.reserve();
    if (!reserved.ok) throw new KarmiError(reserved.code, reserved.message);
    const result = await sandbox.run(request);
    if (!("pending" in result)) this.armIdle(turn.limits);
    return result;
  }

  /**
   * Handles a Workspace alarm. Returns true when the watchdog recorded the end of a Job, so the Thread must
   * settle the Turn.
   */
  async alarm(kind: "container-idle" | "container-watchdog"): Promise<boolean> {
    if (kind === "container-idle") {
      await this.destroy();
      return false;
    }
    return this.poll();
  }

  /**
   * Stops the process, destroys the container and releases the Scope slot. Does nothing without a reservation.
   * When the container runtime fails or does not answer in time, it keeps the reservation and tries again with the
   * `container-idle` alarm. Thus a Turn can end while its container is not destroyed yet. Returns false when the
   * container is not destroyed yet.
   */
  async destroy(): Promise<boolean> {
    if (!this.host.db.select({ id: containerWorkspaces.id }).from(containerWorkspaces).get()) return true;
    const turn = this.host.turn();
    const sandbox = turn && this.sandbox(turn);
    const driver = this.host.driver();
    if (!sandbox && !driver) throw new Error("Cannot destroy the Workspace without its container runtime.");
    let stopTimer = () => {};
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The container runtime did not destroy the Workspace in time.")),
        DESTROY_WAIT_MS,
      );
      stopTimer = () => clearTimeout(timer);
    });
    try {
      await Promise.race([sandbox ? sandbox.cancel() : driver?.destroy(), timeout]);
    } catch (error) {
      this.host.logger.warn("Container Workspace destroy failed. It is tried again.", { error: errorMessage(error) });
      this.host.scheduler.cancel("container-watchdog");
      this.host.scheduler.set({
        id: "container-idle",
        kind: "container-idle",
        dueAt: this.host.now() + DESTROY_RETRY_MS,
        payload: {},
      });
      return false;
    } finally {
      stopTimer();
    }
    await this.host.release();
    this.host.db.delete(containerWorkspaces).run();
    this.host.scheduler.cancel("container-watchdog");
    this.host.scheduler.cancel("container-idle");
    return true;
  }

  /** Empties the Workspace tables when the Thread is deleted. Call it inside the delete transaction. */
  clear(): void {
    this.host.db.delete(containerRuns).run();
    this.host.db.delete(containerWorkspaces).run();
  }

  private async poll(): Promise<boolean> {
    if (this.host.busy()) {
      this.armWatchdog();
      return false;
    }
    const turn = this.host.turn();
    const sandbox = turn && this.sandbox(turn);
    const run = this.readRun();
    if (!turn || !sandbox || !run) return false;
    const jobId = this.host.pendingJob(run.processId);
    if (!jobId) return false;
    const result = await sandbox.poll(run);
    if (!result) {
      this.armWatchdog();
      return false;
    }
    this.armIdle(turn.limits);
    this.host.db.transaction(() => {
      this.host.recordJob(jobId, result);
      sandbox.acknowledge();
      this.host.scheduler.cancel("container-watchdog");
    });
    return true;
  }

  private readRun(): ContainerRun | undefined {
    return this.host.db.select({ value: containerRuns.value }).from(containerRuns).where(eq(containerRuns.id, 1)).get()
      ?.value;
  }

  private armIdle(limits: ContainerLimits): void {
    this.host.scheduler.set({
      id: "container-idle",
      kind: "container-idle",
      dueAt: this.host.now() + limits.idleMs,
      payload: {},
    });
  }

  private armWatchdog(): void {
    this.host.scheduler.set({
      id: "container-watchdog",
      kind: "container-watchdog",
      dueAt: this.host.now() + WATCHDOG_MS,
      payload: {},
    });
  }

  private sandbox(turn: WorkspaceTurn): CloudflareContainerSandbox | undefined {
    const driver = this.host.driver();
    if (!driver) return undefined;
    const { host } = this;
    const maxBytes = turn.media?.maxBytes ?? DEFAULT_MEDIA_BYTES;
    return new CloudflareContainerSandbox(
      driver,
      {
        now: host.now,
        read: () => this.readRun(),
        save: (run) => {
          host.db
            .insert(containerRuns)
            .values({ id: 1, value: run })
            .onConflictDoUpdate({ target: containerRuns.id, set: { value: run } })
            .run();
          this.armWatchdog();
        },
        clear: () => {
          host.db.delete(containerRuns).run();
        },
        progress: (jobId, stdout) => {
          if (host.hasStartedJob(jobId))
            host.append({ type: "job.progress", jobId, content: [{ type: "text", text: stdout }] });
        },
        load: async (ref) => {
          if (!threadMayRead(ref.key, host.scope, host.threadId))
            throw new Error("Script files must reference media of this Thread.");
          const object = await host.bucket?.get(ref.key);
          if (!object) throw new Error("Script input media is unavailable.");
          if (object.size > maxBytes) throw new Error("Script input exceeds Scope media.maxBytes.");
          return new Uint8Array(await object.arrayBuffer());
        },
        store: (name, bytes) =>
          putMedia(
            {
              bucket: host.bucket,
              scope: host.scope,
              threadId: host.threadId,
              ...(turn.media && { limits: turn.media }),
            },
            bytes.slice().buffer,
            { name },
          ),
        maxBytes,
      },
      turn.limits,
      turn.allow,
    );
  }
}
