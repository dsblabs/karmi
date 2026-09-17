import type { Sandbox, SandboxRequest, SandboxResult } from "./sandbox";
import type { ToolPending } from "./tool";
import type { ContainerDriver, ContainerHost, ContainerLimits, ContainerRun } from "./container-types";
import { errorMessage } from "./errors";

/** Runs shell and Python Scripts with persisted process identities and promotion in place to Jobs. */
export class CloudflareContainerSandbox implements Sandbox {
  constructor(
    private readonly driver: ContainerDriver,
    private readonly host: ContainerHost,
    private readonly limits: ContainerLimits,
    private readonly allow: string[],
  ) {}

  /** Runs until wallMs, returning execution errors as results and promoting unfinished processes in place. */
  async run(request: SandboxRequest): Promise<SandboxResult | ToolPending> {
    try {
      return await this.execute(request);
    } catch (error) {
      await this.cancel();
      return failure(errorMessage(error));
    }
  }

  private async execute(request: SandboxRequest): Promise<SandboxResult | ToolPending> {
    if (!request.container) throw new Error("Container Scripts require language and code.");
    request.signal.throwIfAborted();
    let run = this.host.read();
    const callId = request.callId ?? crypto.randomUUID();
    if (run && run.callId !== callId) {
      await this.cancel();
      run = undefined;
    }
    if (!run) {
      await this.driver.configure(this.allow, this.limits.idleMs);
      const files: Record<string, Uint8Array> = {};
      for (const [name, ref] of Object.entries(request.container.files ?? {})) files[name] = await this.host.load(ref);
      await this.driver.prepare(files);
      request.signal.throwIfAborted();
      const now = this.host.now();
      run = {
        callId,
        processId: crypto.randomUUID(),
        startedAt: now,
        deadline: now + this.limits.jobMaxWallMs,
        offset: 0,
        limits: this.limits,
      };
      this.host.save(run);
      await this.driver.keepAlive(true);
      await this.driver.start(request.code, request.container.language, run.processId);
    }
    while (true) {
      request.signal.throwIfAborted();
      const result = await this.poll(run, false);
      if (result) {
        this.acknowledge();
        return result;
      }
      if (this.host.now() >= run.startedAt + this.limits.wallMs) return { pending: run.processId };
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Polls and persists completion; the host must acknowledge it only after recording the terminal Job event. */
  async poll(run = this.host.read(), emitProgress = true): Promise<SandboxResult | undefined> {
    if (!run) return undefined;
    if (run.completion) return run.completion;
    let result: SandboxResult | undefined;
    try {
      result = await this.observe(run, emitProgress);
    } catch (error) {
      await this.driver.destroy();
      result = failure(errorMessage(error));
    }
    if (result) this.host.save({ ...run, completion: result });
    return result;
  }

  private async observe(run: ContainerRun, emitProgress: boolean): Promise<SandboxResult | undefined> {
    const process = await this.driver.process(run.processId);
    if (!process) {
      await this.driver.keepAlive(false);
      return failure("container_lost: The Workspace process no longer exists.");
    }
    const running = process.status === "starting" || process.status === "running";
    if (running) {
      if (emitProgress) this.progress(run, (await this.driver.logs(run.processId)).stdout, false);
      if (this.host.now() < run.deadline) return undefined;
      await this.stop(run.processId);
      await this.driver.destroy();
      return failure("jobMaxWallMs exceeded.");
    }
    const logs = await this.driver.logs(run.processId);
    if (emitProgress) this.progress(run, logs.stdout, true);
    await this.driver.keepAlive(false);
    if (process.exitCode !== 0)
      return failure(logs.stderr || `Script exited with ${process.exitCode ?? process.status}.`);
    const artifacts = [];
    for await (const file of this.driver.artifacts(run.limits.maxArtifacts, this.host.maxBytes))
      artifacts.push(await this.host.store(file.name, file.bytes));
    return {
      value: { stdout: logs.stdout, stderr: logs.stderr, exitCode: 0 },
      logs: [logs.stdout, logs.stderr],
      toolCalls: [],
      artifacts,
    };
  }

  private progress(run: ContainerRun, stdout: string, drain: boolean): void {
    let offset = run.offset;
    while (offset < stdout.length) {
      let chunk = "";
      let size = 0;
      for (const char of stdout.slice(offset, offset + 4096)) {
        const bytes = new TextEncoder().encode(char).length;
        if (size + bytes > 4096) break;
        size += bytes;
        chunk += char;
      }
      this.host.progress(run.processId, chunk);
      offset += chunk.length;
      this.host.save({ ...run, offset });
      if (!drain) return;
    }
  }

  /** Clears a process only after its result has been durably consumed by the host. */
  acknowledge(): void {
    this.host.clear();
  }

  private async stop(id: string): Promise<void> {
    await this.driver.kill(id, "SIGTERM");
    const process = await this.driver.process(id);
    if (process?.status === "running" || process?.status === "starting") await this.driver.kill(id, "SIGKILL");
  }

  /** Stops a pending process and destroys the Workspace; destruction failures remain retryable by the host. */
  async cancel(): Promise<void> {
    const run = this.host.read();
    try {
      if (run && (await this.driver.process(run.processId))) await this.stop(run.processId);
    } catch (error) {
      this.host.progress(run?.processId ?? "", errorMessage(error));
    } finally {
      await this.driver.destroy();
      this.host.clear();
    }
  }
}

function failure(message: string): SandboxResult {
  return { error: { message }, logs: [message], toolCalls: [], artifacts: [] };
}
