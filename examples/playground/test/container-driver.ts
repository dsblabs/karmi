import type { ContainerDriver, ContainerProcess } from "@karmi/core/sandbox";

/**
 * The container runtime of the test Workers. It runs no code. A Script that calls `sleep` stays running and writes
 * one more progress line at each log read. Each other Script completes at once and writes one file for each literal
 * `/out/<name>` path in its code. Thus the Harness, the Workspace and the artifact path run for real.
 */
export class FakeContainer implements ContainerDriver {
  /** The files of the last `prepare`, by name. */
  files: Record<string, Uint8Array> = {};
  /** The hostnames of the last `configure`. */
  allowed: string[] = [];
  /** The signals that `kill` got, in order. */
  signals: string[] = [];
  destroyed = false;
  private readonly processes = new Map<string, ContainerProcess & { code: string; steps: number }>();

  async configure(allow: string[]): Promise<void> {
    this.allowed = allow;
    this.destroyed = false;
  }

  async prepare(files: Record<string, Uint8Array>): Promise<void> {
    this.files = files;
  }

  async start(code: string, _language: string, id: string): Promise<ContainerProcess> {
    const running = /\bsleep\b/.test(code);
    const process = { id, code, steps: 0, ...(running ? { status: "running" as const } : completed) };
    this.processes.set(id, process);
    return process;
  }

  async process(id: string): Promise<ContainerProcess | null> {
    return this.processes.get(id) ?? null;
  }

  async logs(id: string): Promise<{ stdout: string; stderr: string }> {
    const process = this.processes.get(id);
    if (!process) return { stdout: "", stderr: "" };
    if (process.status === "running") process.steps += 1;
    const steps = Array.from({ length: process.steps }, (_, step) => `Step ${String(step + 1)}\n`).join("");
    const names = Object.keys(this.files).join(", ") || "no files";
    return { stdout: `${steps}Fake container: read ${names}.\n`, stderr: "" };
  }

  async *artifacts(): AsyncIterable<{ name: string; bytes: Uint8Array }> {
    const process = [...this.processes.values()].at(-1);
    for (const [, name] of process?.code.matchAll(/\/out\/([\w.-]+)/g) ?? [])
      if (name) yield { name, bytes: new TextEncoder().encode(`Fake output: ${name}\n`) };
  }

  async kill(id: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.signals.push(signal);
    const process = this.processes.get(id);
    if (process) process.status = "killed";
  }

  async keepAlive(): Promise<void> {}

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.processes.clear();
  }

  /** Ends each running process with exit code 0, as a long Script does when it finishes. */
  finish(): void {
    for (const process of this.processes.values()) if (process.status === "running") Object.assign(process, completed);
  }
}

const completed = { status: "completed", exitCode: 0 } as const;

const workspaces = new Map<string, FakeContainer>();

/** Returns the fake container of one Workspace. The Workspace id is `{scope}/{threadId}`. */
export function fakeContainer(workspaceId: string): FakeContainer {
  let container = workspaces.get(workspaceId);
  if (!container) workspaces.set(workspaceId, (container = new FakeContainer()));
  return container;
}
