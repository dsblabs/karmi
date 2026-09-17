import { Sandbox as CloudflareSandbox, ContainerProxy as SandboxProxy } from "@cloudflare/sandbox";
import type { ContainerDriver } from "./container-types";

/** Explains denied egress and records it in the Script's stderr without weakening the SDK allowlist. */
export class ContainerProxy extends SandboxProxy {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (response.status !== 520) return response;
    const message = `Egress denied (520): ${new URL(request.url).hostname}; grant capabilities.scripts.egress.allow.`;
    // The SDK proxy types its environment independently of the Worker binding contract.
    const bindings = this.env as { KARMI_SANDBOX?: DurableObjectNamespace<KarmiSandbox> };
    const namespace = bindings.KARMI_SANDBOX;
    if (namespace) await namespace.get(namespace.idFromString(this.ctx.props.containerId)).recordDenial(message);
    return new Response(message, { status: 520 });
  }
}
/** The Sandbox Durable Object with HTTPS interception and deny-by-default outbound access. */
export class KarmiSandbox extends CloudflareSandbox {
  override interceptHttps = true;
  override enableInternet = false;
  override allowedHosts: string[] = [];
  /** Records bounded denial diagnostics outside the Script's filesystem. */
  async recordDenial(message: string): Promise<void> {
    const prior = (await this.ctx.storage.get<string>("denials")) ?? "";
    await this.ctx.storage.put("denials", (prior + message + "\n").slice(-4096));
  }
  /** Reads the denied destinations recorded for the current Script. */
  async denials(): Promise<string> {
    return (await this.ctx.storage.get<string>("denials")) ?? "";
  }
  /** Clears diagnostics before the next Script. */
  async clearDenials(): Promise<void> {
    await this.ctx.storage.delete("denials");
  }
}
/** Creates the SDK driver for a Workspace named by Scope and Thread. */
export function cloudflareContainer(namespace: DurableObjectNamespace<KarmiSandbox>, id: string): ContainerDriver {
  // Direct naming preserves long Thread identities without the preview URL length restriction.
  const sandbox = namespace.getByName(id);
  return {
    configure: async (allow, idleMs) => {
      await sandbox.clearDenials();
      await sandbox.setAllowedHosts(allow);
      await sandbox.setSleepAfter(idleMs / 1000);
    },
    prepare: async (files) => {
      const result = await sandbox.exec(
        "rm -rf /in /out && mkdir -p /in /out && cp /etc/ssl/certs/ca-certificates.crt /tmp/karmi-ca && if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then cat /etc/cloudflare/certs/cloudflare-containers-ca.crt >> /tmp/karmi-ca; fi",
      );
      if (!result.success) throw new Error(result.stderr);
      for (const [name, bytes] of Object.entries(files))
        await sandbox.writeFile(`/in/${name}`, toBase64(bytes), { encoding: "base64" });
    },
    start: async (code, language, processId) => {
      await sandbox.writeFile("/tmp/karmi-script", code);
      return sandbox.startProcess(
        `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp SSL_CERT_FILE=/tmp/karmi-ca REQUESTS_CA_BUNDLE=/tmp/karmi-ca NODE_EXTRA_CA_CERTS=/tmp/karmi-ca ${language === "python" ? "python3" : "sh"} /tmp/karmi-script`,
        { processId, autoCleanup: false, cwd: "/" },
      );
    },
    process: (id) => sandbox.getProcess(id),
    logs: async (id) => {
      const logs = await sandbox.getProcessLogs(id);
      return { stdout: logs.stdout, stderr: logs.stderr + (await sandbox.denials()) };
    },
    artifacts: async function* (max, maxBytes) {
      const listing = await sandbox.listFiles("/out", { recursive: true });
      const files = listing.files.filter((file) => file.type === "file");
      if (files.length > max) throw new Error("maxArtifacts exceeded.");
      for (const file of files) {
        if (file.size > maxBytes) throw new Error("Artifact exceeds Scope media.maxBytes.");
        const result = await sandbox.readFile(file.absolutePath, { encoding: "base64" });
        yield {
          name: file.relativePath,
          bytes: Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0)),
        };
      }
    },
    kill: async (id, signal) => {
      const process = await sandbox.getProcess(id);
      if (!process || process.status === "completed" || process.status === "failed" || process.status === "killed")
        return;
      const pid = process.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1)
        throw new Error("Container process has no valid PID.");
      // SDK 0.12.9 ignores killProcess's signal argument, so send the requested signal explicitly.
      const result = await sandbox.exec(`kill -s ${signal === "SIGTERM" ? "TERM" : "KILL"} ${pid}`);
      if (!result.success && (await sandbox.getProcess(id))?.status === "running") throw new Error(result.stderr);
    },
    keepAlive: (value) => sandbox.setKeepAlive(value),
    destroy: () => sandbox.destroy(),
  };
}

function toBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 24576)
    encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576)));
  return encoded;
}
