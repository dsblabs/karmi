import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRequest, CommandRunner, DeploymentManifest, ManifestStore } from "./deployment.ts";

/** Runs Wrangler as a child process and captures its output. */
export class WranglerRunner implements CommandRunner {
  /** Runs one Wrangler command in the Playground directory. */
  run(request: CommandRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["exec", "wrangler", ...request.args], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, ...request.env },
        stdio: request.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(errors.trim() || output.trim() || `Wrangler exited with code ${String(code)}.`));
      });
      child.stdin?.end(request.input);
    });
  }
}

/** Stores one deployment manifest as formatted JSON. */
export class FileManifestStore implements ManifestStore {
  readonly #file: URL;

  /** Creates a store for the given manifest file. */
  constructor(file: URL) {
    this.#file = file;
  }

  /** Saves the manifest after creating its parent directory. */
  async save(manifest: DeploymentManifest): Promise<void> {
    await mkdir(new URL(".", this.#file), { recursive: true });
    await writeFile(this.#file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
  }
}

/** Reads a deployment manifest from disk. */
export async function readManifest(file: URL): Promise<DeploymentManifest> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("account" in value) ||
    !("worker" in value) ||
    !("queue" in value) ||
    !("deadLetterQueue" in value) ||
    !("bucket" in value) ||
    typeof value.account !== "object" ||
    value.account === null ||
    !("id" in value.account) ||
    typeof value.account.id !== "string" ||
    !("name" in value.account) ||
    typeof value.account.name !== "string"
  ) {
    throw new Error("The deployment manifest is invalid.");
  }
  const decodeResource = (resource: unknown): DeploymentManifest["worker"] => {
    if (
      typeof resource !== "object" ||
      resource === null ||
      !("name" in resource) ||
      typeof resource.name !== "string" ||
      !("owned" in resource) ||
      typeof resource.owned !== "boolean" ||
      !("status" in resource) ||
      (resource.status !== "pending" &&
        resource.status !== "creating" &&
        resource.status !== "created" &&
        resource.status !== "removed")
    ) {
      throw new Error("The deployment manifest has an invalid resource.");
    }
    return { name: resource.name, owned: resource.owned, status: resource.status };
  };
  return {
    version: 1,
    name: value.name,
    account: { id: value.account.id, name: value.account.name },
    worker: decodeResource(value.worker),
    queue: decodeResource(value.queue),
    deadLetterQueue: decodeResource(value.deadLetterQueue),
    bucket: decodeResource(value.bucket),
  };
}

/** Builds the Wrangler configuration for one deployment. */
export function buildCloudflareConfig(
  base: Readonly<Record<string, unknown>>,
  manifest: DeploymentManifest,
  variables: Readonly<Record<string, string>>,
): string {
  const assets =
    typeof base.assets === "object" && base.assets !== null && !Array.isArray(base.assets)
      ? { ...base.assets, directory: "../../public" }
      : { directory: "../../public" };
  const r2Buckets = Array.isArray(base.r2_buckets)
    ? base.r2_buckets.map((entry) =>
        typeof entry === "object" && entry !== null ? { ...entry, bucket_name: manifest.bucket.name } : entry,
      )
    : [];
  const baseQueues =
    typeof base.queues === "object" && base.queues !== null ? Object.fromEntries(Object.entries(base.queues)) : {};
  const baseProducers: unknown = baseQueues.producers;
  const baseConsumers: unknown = baseQueues.consumers;
  const producers = Array.isArray(baseProducers)
    ? baseProducers.map((entry: unknown) =>
        typeof entry === "object" && entry !== null ? { ...entry, queue: manifest.queue.name } : entry,
      )
    : [];
  const consumers = Array.isArray(baseConsumers)
    ? baseConsumers.map((entry: unknown) =>
        typeof entry === "object" && entry !== null
          ? { ...entry, queue: manifest.queue.name, dead_letter_queue: manifest.deadLetterQueue.name }
          : entry,
      )
    : [];
  return `${JSON.stringify(
    {
      ...base,
      name: manifest.name,
      main: "../../src/worker.ts",
      assets,
      vars: variables,
      r2_buckets: r2Buckets,
      queues: { ...baseQueues, producers, consumers },
    },
    undefined,
    2,
  )}\n`;
}

/** Reads the local Wrangler configuration as the source for a cloud deployment. */
export async function readBaseConfig(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The Playground Wrangler configuration is invalid.");
  }
  return Object.fromEntries(Object.entries(value));
}

/** Writes the generated Wrangler configuration beside its manifest. */
export async function writeCloudflareConfig(file: URL, content: string): Promise<void> {
  await mkdir(dirname(file.pathname), { recursive: true });
  await writeFile(file, content, { mode: 0o600 });
}
