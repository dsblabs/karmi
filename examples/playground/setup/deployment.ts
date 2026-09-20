/** A Cloudflare account available to the operator. */
export interface CloudflareAccount {
  /** The Cloudflare account identifier. */
  id: string;
  /** The Cloudflare account name. */
  name: string;
}

/** A resource tracked by a Playground deployment. */
export interface DeploymentResource {
  /** The Cloudflare resource name. */
  name: string;
  /** Whether the deployment command created and owns the resource. */
  owned: boolean;
  /** The last durable lifecycle state. */
  status: "pending" | "creating" | "created" | "removed";
}

/** The durable ownership record for one Playground deployment. */
export interface DeploymentManifest {
  /** The manifest format version. */
  version: 1;
  /** The distinct Worker and deployment name. */
  name: string;
  /** The Cloudflare account that owns the deployment. */
  account: CloudflareAccount;
  /** The Worker resource. */
  worker: DeploymentResource;
  /** The primary Queue resource. */
  queue: DeploymentResource;
  /** The dead-letter Queue resource. */
  deadLetterQueue: DeploymentResource;
  /** The R2 storage resource. */
  bucket: DeploymentResource;
}

/** Options for resources that an operator supplies instead of creating. */
export interface SuppliedResources {
  /** An existing Queue name. */
  queue?: string;
  /** An existing dead-letter Queue name. */
  deadLetterQueue?: string;
  /** An existing R2 bucket name. */
  bucket?: string;
}

/** Command-line choices for a deployment. */
export interface DeploymentArguments {
  /** A deployment name to use without a prompt. */
  name?: string;
  /** Resources supplied by the operator. */
  supplied: SuppliedResources;
}

/** One external command request. */
export interface CommandRequest {
  /** Command arguments after `wrangler`. */
  args: readonly string[];
  /** Data written to standard input. */
  input?: string;
  /** Environment variables added to the Wrangler process. */
  env?: Readonly<Record<string, string>>;
  /** Whether the command uses the operator's terminal directly. */
  interactive?: boolean;
}

/** Runs Wrangler commands at the deployment boundary. */
export interface CommandRunner {
  /** Runs one command and rejects when it fails. */
  run(request: CommandRequest): Promise<string>;
}

/** Persists the ownership record after each resource operation. */
export interface ManifestStore {
  /** Saves the complete current manifest. */
  save(manifest: DeploymentManifest): Promise<void>;
}

/** A cleanup failure for one resource. */
export interface RemovalFailure {
  /** The resource kind and name. */
  resource: string;
  /** The command failure message. */
  message: string;
}

/** The result of a removal attempt. */
export type RemovalResult =
  { complete: true; preserved: string[] } | { complete: false; preserved: string[]; failures: RemovalFailure[] };

function resource(name: string, owned: boolean): DeploymentResource {
  return { name, owned, status: owned ? "pending" : "created" };
}

/** Creates an ownership record before the first Cloudflare resource is created. */
export function createManifest(
  name: string,
  account: CloudflareAccount,
  supplied: SuppliedResources = {},
): DeploymentManifest {
  return {
    version: 1,
    name,
    account,
    worker: resource(name, true),
    queue: resource(supplied.queue ?? `${name}-queue`, supplied.queue === undefined),
    deadLetterQueue: resource(supplied.deadLetterQueue ?? `${name}-dlq`, supplied.deadLetterQueue === undefined),
    bucket: resource(supplied.bucket ?? `${name}-media`, supplied.bucket === undefined),
  };
}

/** Decodes Wrangler's authenticated account response. */
export function decodeAccounts(value: unknown): CloudflareAccount[] {
  if (typeof value !== "object" || value === null || !("accounts" in value) || !Array.isArray(value.accounts)) {
    throw new Error("Wrangler did not return a list of Cloudflare accounts.");
  }
  return value.accounts.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    ) {
      throw new Error("Wrangler returned an invalid Cloudflare account.");
    }
    return { id: entry.id, name: entry.name };
  });
}

/** Selects one account by its one-based position, identifier or exact name. */
export function selectAccount(accounts: readonly CloudflareAccount[], answer: string): CloudflareAccount | undefined {
  const text = answer.trim();
  return accounts[Number(text) - 1] ?? accounts.find((account) => account.id === text || account.name === text);
}

/** Decodes the optional deployment name and supplied resource flags. */
export function parseDeploymentArguments(args: readonly string[]): DeploymentArguments {
  const supplied: SuppliedResources = {};
  let name: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      if (name) throw new Error("Give only one deployment name.");
      name = argument;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a resource name.`);
    if (argument === "--bucket") supplied.bucket = value;
    else if (argument === "--queue") supplied.queue = value;
    else if (argument === "--dead-letter-queue") supplied.deadLetterQueue = value;
    else throw new Error(`Unknown deployment option: ${argument}.`);
    index += 1;
  }
  return { ...(name ? { name } : {}), supplied };
}

function command(args: string[], accountId: string, input?: string): CommandRequest {
  return { args, env: { CLOUDFLARE_ACCOUNT_ID: accountId }, ...(input === undefined ? {} : { input }) };
}

async function createOwnedResource(
  manifest: DeploymentManifest,
  key: "queue" | "deadLetterQueue" | "bucket",
  runner: CommandRunner,
  store: ManifestStore,
): Promise<void> {
  const current = manifest[key];
  if (!current.owned || current.status === "created") return;
  const prefix = key === "bucket" ? ["r2", "bucket"] : ["queues"];
  if (current.status === "pending") {
    try {
      await runner.run(command([...prefix, "info", current.name], manifest.account.id));
      throw new Error(`${key} ${current.name} already exists and is not owned by this deployment.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    current.status = "creating";
    await store.save(manifest);
  }
  try {
    await runner.run(command([...prefix, "create", current.name], manifest.account.id));
  } catch (error) {
    if (!errorMessage(error).toLowerCase().includes("already exists")) throw error;
  }
  current.status = "created";
  await store.save(manifest);
}

async function verifySuppliedResources(manifest: DeploymentManifest, runner: CommandRunner): Promise<void> {
  const resources: Array<{ resource: DeploymentResource; args: string[] }> = [
    { resource: manifest.bucket, args: ["r2", "bucket", "info", manifest.bucket.name] },
    { resource: manifest.deadLetterQueue, args: ["queues", "info", manifest.deadLetterQueue.name] },
    { resource: manifest.queue, args: ["queues", "info", manifest.queue.name] },
  ];
  for (const entry of resources) {
    if (!entry.resource.owned) await runner.run(command(entry.args, manifest.account.id));
  }
}

/** Creates missing owned resources, stores secrets and deploys the Worker. */
export async function deploy(
  manifest: DeploymentManifest,
  secrets: Readonly<Record<string, string>>,
  configPath: string,
  runner: CommandRunner,
  store: ManifestStore,
): Promise<void> {
  await store.save(manifest);
  if (manifest.worker.status === "pending") {
    try {
      await runner.run(command(["deployments", "list", "--name", manifest.worker.name, "--json"], manifest.account.id));
      throw new Error(`Worker ${manifest.worker.name} already exists and is not owned by this deployment.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    manifest.worker.status = "creating";
    await store.save(manifest);
  }
  await verifySuppliedResources(manifest, runner);
  await createOwnedResource(manifest, "bucket", runner, store);
  await createOwnedResource(manifest, "deadLetterQueue", runner, store);
  await createOwnedResource(manifest, "queue", runner, store);
  await runner.run(command(["deploy", "--config", configPath], manifest.account.id));
  manifest.worker.status = "created";
  await store.save(manifest);
  await runner.run(command(["secret", "bulk", "--config", configPath], manifest.account.id, JSON.stringify(secrets)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("does not exist");
}

/** Removes each owned resource and reports all resources that remain. */
export async function remove(
  manifest: DeploymentManifest,
  runner: CommandRunner,
  store: ManifestStore,
): Promise<RemovalResult> {
  const preserved: string[] = [];
  const failures: RemovalFailure[] = [];
  const operations: Array<{ key: "worker" | "queue" | "deadLetterQueue" | "bucket"; args: string[] }> = [
    {
      key: "worker",
      args: ["delete", manifest.worker.name, "--force"],
    },
    {
      key: "queue",
      args: ["queues", "delete", manifest.queue.name],
    },
    {
      key: "deadLetterQueue",
      args: ["queues", "delete", manifest.deadLetterQueue.name],
    },
    {
      key: "bucket",
      args: ["r2", "bucket", "delete", manifest.bucket.name],
    },
  ];
  for (const operation of operations) {
    const current = manifest[operation.key];
    const label = `${operation.key} ${current.name}`;
    if (!current.owned) {
      preserved.push(label);
      continue;
    }
    if (current.status === "removed" || current.status === "pending") continue;
    try {
      await runner.run(command(operation.args, manifest.account.id));
      current.status = "removed";
      await store.save(manifest);
    } catch (error) {
      const message = errorMessage(error);
      if (isMissing(error)) {
        current.status = "removed";
        await store.save(manifest);
      } else failures.push({ resource: label, message });
    }
  }
  return failures.length === 0 ? { complete: true, preserved } : { complete: false, preserved, failures };
}
