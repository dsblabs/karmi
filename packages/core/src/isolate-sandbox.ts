import { RpcTarget } from "cloudflare:workers";
import * as z from "zod/mini";
import { errorMessage } from "./errors";
import type { Sandbox, SandboxRequest, SandboxResult, ScriptToolCall } from "./sandbox";
import { parseForCodemode, stringifyForCodemode, SANDBOX_CODEC } from "./vendor/codemode/codec";
import { disposeQuietly } from "./vendor/codemode/runtime";

// The one-shot load, RPC envelopes, console capture and disposal are adapted from Codemode
// (MIT, see vendor/codemode/NOTICE).

/** The RPC target a Script's `tools` and `__result` globals call into from the isolate. */
class ToolBridge extends RpcTarget {
  #request: SandboxRequest;
  #count = 0;
  #queue: Promise<unknown> = Promise.resolve();
  readonly calls: ScriptToolCall[] = [];
  breach?: string;
  readonly logs: string[] = [];
  #logSize = 0;
  log(text: string): void {
    if (this.#request.signal.aborted || this.#logSize >= 30000 || typeof text !== "string") return;
    const line = text.slice(0, 30000 - this.#logSize);
    this.#logSize += line.length + 1;
    this.logs.push(line);
  }
  constructor(request: SandboxRequest) {
    super();
    this.#request = request;
  }
  async call(name: string, json: string): Promise<string> {
    try {
      this.#request.signal.throwIfAborted();
      if (!this.#request.tools.includes(name)) return stringifyForCodemode({ error: `Tool "${name}" is unavailable.` });
      if (++this.#count > this.#request.limits.maxToolCalls) {
        this.breach = "limit_exceeded: maxToolCalls";
        return stringifyForCodemode({ error: this.breach });
      }
      // Calls run one at a time so a mutating Tool cannot race another call.
      const work = this.#queue.then(async () => {
        this.#request.signal.throwIfAborted();
        const result = await this.#request.call(name, parseForCodemode(json), this.#request.signal);
        this.calls.push({ callId: result.callId, name, isError: result.isError });
        return result.isError ? { error: errorMessage(result.value) } : { result: result.value };
      });
      this.#queue = work.catch(() => undefined);
      return stringifyForCodemode(await work);
    } catch (error) {
      return stringifyForCodemode({ error: errorMessage(error) });
    }
  }
  async result(callId: string): Promise<string> {
    try {
      this.#request.signal.throwIfAborted();
      return stringifyForCodemode({ result: await this.#request.result(callId) });
    } catch (error) {
      return stringifyForCodemode({ error: errorMessage(error) });
    }
  }
}

const ResponseSchema = z.union([
  z.object({ value: z.unknown(), logs: z.array(z.string()) }),
  z.object({ error: z.object({ message: z.string(), stack: z.optional(z.string()) }), logs: z.array(z.string()) }),
]);

/**
 * The `isolate` Sandbox tier: runs a Script in a Dynamic Worker with no filesystem, network, secrets
 * or storage. A breached CPU, wall-clock or Tool-call limit ends the run with a `limit_exceeded` error.
 */
export class CloudflareIsolateSandbox implements Sandbox {
  constructor(private readonly loader: WorkerLoader) {}
  async run(request: SandboxRequest): Promise<SandboxResult> {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const bridge = new ToolBridge({ ...request, signal });
    let worker: WorkerStub | undefined;
    let entry: ReturnType<WorkerStub["getEntrypoint"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      worker = this.loader.load({
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["disable_nodejs_fs_module", "disallow_importable_env"],
        mainModule: "executor.js",
        globalOutbound: null,
        limits: { cpuMs: request.limits.cpuMs },
        modules: { "executor.js": executorModule(request.tools), "script.js": request.code },
      });
      entry = worker.getEntrypoint();
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        timer = setTimeout(() => controller.abort(new Error("limit_exceeded: wallMs")), request.limits.wallMs);
      });
      const raw: unknown = await Promise.race([evaluate(entry, bridge), aborted]);
      if (typeof raw !== "string") throw new Error("Invalid Sandbox response.");
      const response = z.parse(ResponseSchema, parseForCodemode(raw));
      if (bridge.breach)
        return { error: { message: bridge.breach }, logs: response.logs, toolCalls: bridge.calls, artifacts: [] };
      return { ...response, toolCalls: bridge.calls, artifacts: [] };
    } catch (error) {
      const message = errorMessage(error);
      return {
        error: {
          message: /CPU|cpu time|exceeded resource limits/i.test(message) ? "limit_exceeded: cpuMs" : message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
        logs: [...bridge.logs],
        toolCalls: bridge.calls,
        artifacts: [],
      };
    } finally {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      disposeQuietly(entry);
      disposeQuietly(worker);
    }
  }
}

function executorModule(names: readonly string[]): string {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
${SANDBOX_CODEC}
export default class extends WorkerEntrypoint {
  async evaluate(bridge) {
    const logs = [];
    let size = 0;
    for (const level of ["log", "info", "debug", "warn", "error"]) console[level] = (...args) => {
      if (size >= 30000) return;
      const text = args.map(String).join(" ").slice(0, 30000 - size);
      size += text.length + 1;
      const line = level === "log" ? text : "[" + level + "] " + text;
      logs.push(line); void bridge.log(line);
    };
    const unwrap = json => { const data = __parseForCodemode(json); if (data.error) throw new Error(data.error); return data.result; };
    globalThis.tools = Object.freeze(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, async input => unwrap(await bridge.call(name, __stringifyForCodemode(input)))])));
    globalThis.__result = async callId => unwrap(await bridge.result(callId));
    try {
      const script = await import("./script.js");
      const value = typeof script.default === "function" ? await script.default() : script.default;
      return __stringifyForCodemode({ value: value === undefined ? null : value, logs });
    } catch (error) {
      return __stringifyForCodemode({ error: { message: String(error?.message ?? error), stack: error?.stack }, logs });
    }
  }
}`;
}

function evaluate(entry: object, bridge: ToolBridge): Promise<unknown> {
  if (!("evaluate" in entry) || typeof entry.evaluate !== "function") throw new Error("Invalid Sandbox entrypoint.");
  return entry.evaluate(bridge);
}
