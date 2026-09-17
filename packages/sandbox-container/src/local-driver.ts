import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerDriver, ContainerProcess } from "@karmi/core/sandbox";

interface ProcessRecord {
  child: ChildProcess;
  state: ContainerProcess;
  stdout: string;
  stderr: string;
}
/** Executes trusted local Scripts with a temporary disk and no environment credentials or egress enforcement. */
export class LocalContainerDriver implements ContainerDriver {
  private directory: string | undefined;
  private processes = new Map<string, ProcessRecord>();

  async configure(): Promise<void> {
    this.directory ??= await mkdtemp(join(tmpdir(), "karmi-"));
  }

  async prepare(files: Record<string, Uint8Array>): Promise<void> {
    const root = this.root();
    for (const name of ["in", "out"]) {
      await rm(join(root, name), { recursive: true, force: true });
      await mkdir(join(root, name));
    }
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, "in", name), bytes);
  }

  async start(code: string, language: "shell" | "python", id: string): Promise<ContainerProcess> {
    const root = this.root();
    const translated = code.replace(/\/(in|out)(?=\/|[\s'";)]|$)/g, (_, directory: string) => join(root, directory));
    const script = join(root, language === "python" ? "script.py" : "script.sh");
    await writeFile(script, translated);
    const child = spawn(language === "python" ? "python3" : "sh", [script], {
      cwd: root,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record: ProcessRecord = { child, state: { id, status: "running" }, stdout: "", stderr: "" };
    this.processes.set(id, record);
    child.stdout?.on("data", (chunk: Buffer) => {
      record.stdout = (record.stdout + chunk.toString()).slice(-1024 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      record.stderr = (record.stderr + chunk.toString()).slice(-1024 * 1024);
    });
    child.on("error", (error) => {
      record.stderr = error.message;
      record.state = { id, status: "error" };
    });
    child.on("close", (exitCode) => {
      record.state = { id, status: exitCode === 0 ? "completed" : "failed", ...(exitCode !== null && { exitCode }) };
    });
    return record.state;
  }

  async process(id: string): Promise<ContainerProcess | null> {
    return this.processes.get(id)?.state ?? null;
  }
  async logs(id: string): Promise<{ stdout: string; stderr: string }> {
    const record = this.processes.get(id);
    return { stdout: record?.stdout ?? "", stderr: record?.stderr ?? "" };
  }
  async *artifacts(max: number, maxBytes: number): AsyncIterable<{ name: string; bytes: Uint8Array }> {
    const root = join(this.root(), "out");
    const files = await readdir(root, { withFileTypes: true, recursive: true });
    let count = 0;
    for (const file of files) {
      if (!file.isFile()) continue;
      if (count++ >= max) throw new Error("maxArtifacts exceeded.");
      const path = join(file.parentPath, file.name);
      if ((await lstat(path)).size > maxBytes) throw new Error("Artifact exceeds Scope media.maxBytes.");
      yield { name: path.slice(root.length + 1), bytes: new Uint8Array(await readFile(path)) };
    }
  }
  async kill(id: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const child = this.processes.get(id)?.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  async keepAlive(): Promise<void> {}
  async destroy(): Promise<void> {
    for (const id of this.processes.keys()) await this.kill(id, "SIGKILL");
    this.processes.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
  private root(): string {
    if (!this.directory) throw new Error("Workspace has not been configured.");
    return this.directory;
  }
}
