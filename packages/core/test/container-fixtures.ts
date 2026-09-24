import type { ContainerDriver, ContainerProcess } from "../src/container-types";

/** The external container runtime double used by Harness integration tests. */
export class TestContainerDriver implements ContainerDriver {
  processes = new Map<string, ContainerProcess>();
  starts: string[] = [];
  allowed: string[] = [];
  files: Record<string, Uint8Array> = {};
  signals: string[] = [];
  alive = false;
  destroyed = false;
  async configure(allow: string[]): Promise<void> {
    this.allowed = allow;
    this.destroyed = false;
  }
  async prepare(files: Record<string, Uint8Array>): Promise<void> {
    this.files = files;
  }
  async start(code: string, _language: string, id: string): Promise<ContainerProcess> {
    this.starts.push(code);
    const process: ContainerProcess =
      code === "pending" ? { id, status: "running" } : { id, status: "completed", exitCode: 0 };
    this.processes.set(id, process);
    return process;
  }
  async process(id: string): Promise<ContainerProcess | null> {
    return this.processes.get(id) ?? null;
  }
  async logs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: "stdout", stderr: "" };
  }
  async *artifacts(): AsyncIterable<{ name: string; bytes: Uint8Array }> {
    yield { name: "answer.txt", bytes: new TextEncoder().encode("answer") };
  }
  async kill(id: string, signal: string): Promise<void> {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.processes.delete(id);
  }
  async keepAlive(value: boolean): Promise<void> {
    this.alive = value;
  }
  /** The number of next `destroy` calls that fail, like a Sandbox Durable Object that resets during the call. */
  failDestroys = 0;
  async destroy(): Promise<void> {
    if (this.failDestroys > 0) {
      this.failDestroys -= 1;
      throw new Error("Connection closed: this Durable Object instance is no longer active.");
    }
    this.destroyed = true;
    this.alive = false;
    this.processes.clear();
  }
}
const drivers = new Map<string, TestContainerDriver>();
/** Opens one external runtime double per Workspace identity. */
export function testContainer(id: string): TestContainerDriver {
  let driver = drivers.get(id);
  if (!driver) {
    driver = new TestContainerDriver();
    drivers.set(id, driver);
  }
  return driver;
}
