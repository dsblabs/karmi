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
  /**
   * Whether the Worker gets the Worker Loader binding of isolate Scripts. Dynamic Workers need the Workers Paid
   * plan. The binding is part of the Worker, thus it creates no resource and removal has nothing more to delete.
   */
  isolateScripts: boolean;
  /**
   * The container application of container Scripts, when the deployment selected them. Its name is also the name of
   * the images that the deployment pushed to the Cloudflare registry. Removal deletes the application and each image.
   */
  container?: DeploymentResource;
}

/** The optional services that a deployment selects when it is created. */
export interface OptionalServices {
  /** Gives the Worker the Worker Loader binding. Dynamic Workers need the Workers Paid plan. */
  isolateScripts?: boolean;
  /** Creates the container application of container Scripts. Containers need the Workers Paid plan and Docker. */
  containerScripts?: boolean;
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

/** Deletes the objects in an R2 bucket at the deployment boundary. */
export interface BucketCleaner {
  /** Deletes every object in the bucket and rejects when one delete fails. */
  empty(accountId: string, bucket: string): Promise<void>;
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
  { isolateScripts = false, containerScripts = false }: OptionalServices = {},
): DeploymentManifest {
  return {
    version: 1,
    name,
    account,
    isolateScripts,
    ...(containerScripts && { container: resource(`${name}-sandbox`, true) }),
    worker: resource(name, true),
    queue: resource(supplied.queue ?? `${name}-queue`, supplied.queue === undefined),
    deadLetterQueue: resource(supplied.deadLetterQueue ?? `${name}-dlq`, supplied.deadLetterQueue === undefined),
    bucket: resource(supplied.bucket ?? `${name}-media`, supplied.bucket === undefined),
  };
}

/** The Durable Object class of the container sandbox, as the Wrangler configuration names it. */
const SANDBOX_CLASS = "KarmiSandbox";

const namesSandbox = (entry: unknown) =>
  typeof entry === "object" &&
  entry !== null &&
  (("class_name" in entry && entry.class_name === SANDBOX_CLASS) ||
    ("new_sqlite_classes" in entry &&
      Array.isArray(entry.new_sqlite_classes) &&
      entry.new_sqlite_classes.includes(SANDBOX_CLASS)));

/**
 * Returns the base Wrangler configuration with the optional bindings that the deployment selected. Without isolate
 * Scripts, the Worker gets no Worker Loader binding. Without container Scripts, it gets no container, no sandbox
 * Durable Object and no sandbox migration. Thus an account without the Workers Paid plan can deploy it.
 */
export function selectBindings(
  base: Readonly<Record<string, unknown>>,
  manifest: DeploymentManifest,
): Record<string, unknown> {
  const { worker_loaders: loaders, containers, ...rest } = base;
  const selected: Record<string, unknown> = { ...rest, ...(manifest.isolateScripts && { worker_loaders: loaders }) };
  const { container } = manifest;
  if (container)
    return {
      ...selected,
      containers: Array.isArray(containers)
        ? containers.map((entry: unknown) =>
            namesSandbox(entry) && typeof entry === "object" ? { ...entry, name: container.name } : entry,
          )
        : [],
    };
  const objects = selected.durable_objects;
  if (typeof objects === "object" && objects !== null && "bindings" in objects && Array.isArray(objects.bindings))
    selected.durable_objects = { ...objects, bindings: objects.bindings.filter((entry) => !namesSandbox(entry)) };
  if (Array.isArray(selected.migrations))
    selected.migrations = selected.migrations.filter((entry) => !namesSandbox(entry));
  return selected;
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
  await claimContainer(manifest, runner, store);
  await runner.run(command(["secret", "bulk", "--config", configPath], manifest.account.id, JSON.stringify(secrets)));
  // Wrangler builds the image, pushes it and creates the container application in the same deploy.
  await runner.run(command(["deploy", "--config", configPath], manifest.account.id));
  manifest.worker.status = "created";
  if (manifest.container) manifest.container.status = "created";
  await store.save(manifest);
}

/**
 * Checks that no container application has the name of the deployment, then records that the deploy creates it.
 * Thus an interrupted deploy leaves a record that removal can use.
 */
async function claimContainer(manifest: DeploymentManifest, runner: CommandRunner, store: ManifestStore) {
  const { container } = manifest;
  if (container?.status !== "pending") return;
  if ((await containerApplications(manifest, runner)).some((application) => application.name === container.name))
    throw new Error(`container ${container.name} already exists and is not owned by this deployment.`);
  container.status = "creating";
  await store.save(manifest);
}

const listed = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Wrangler did not return a JSON list.");
  return value;
};

/** Lists the container applications of the account. */
async function containerApplications(
  manifest: DeploymentManifest,
  runner: CommandRunner,
): Promise<Array<{ id: string; name: string }>> {
  const output = await runner.run(command(["containers", "list", "--json"], manifest.account.id));
  return listed(JSON.parse(output)).flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof entry.id === "string" &&
    "name" in entry &&
    typeof entry.name === "string"
      ? [{ id: entry.id, name: entry.name }]
      : [],
  );
}

/** Returns each tag of the registry images with the given name. */
async function imageTags(manifest: DeploymentManifest, runner: CommandRunner, name: string): Promise<string[]> {
  const output = await runner.run(command(["containers", "images", "list", "--json"], manifest.account.id));
  return listed(JSON.parse(output)).flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "name" in entry &&
    entry.name === name &&
    "tags" in entry &&
    Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  );
}

/** Deletes the owned container application, then each image with its name. */
async function removeContainer(manifest: DeploymentManifest, runner: CommandRunner, name: string): Promise<void> {
  for (const application of await containerApplications(manifest, runner))
    if (application.name === name)
      await runner.run(command(["containers", "delete", application.id], manifest.account.id));
  for (const tag of await imageTags(manifest, runner, name))
    await runner.run(
      command(["containers", "images", "delete", `${name}:${tag}`, "--skip-confirmation"], manifest.account.id),
    );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("does not exist");
}

async function removeQueueConsumer(
  manifest: DeploymentManifest,
  runner: CommandRunner,
): Promise<RemovalFailure | undefined> {
  if (
    !manifest.worker.owned ||
    manifest.worker.status === "pending" ||
    manifest.worker.status === "removed" ||
    manifest.queue.status === "pending" ||
    manifest.queue.status === "removed"
  )
    return;
  try {
    await runner.run(
      command(["queues", "consumer", "remove", manifest.queue.name, manifest.worker.name], manifest.account.id),
    );
  } catch (error) {
    if (!isMissing(error)) return { resource: `queue consumer ${manifest.worker.name}`, message: errorMessage(error) };
  }
}

/** Removes each owned resource and reports all resources that remain. */
export async function remove(
  manifest: DeploymentManifest,
  runner: CommandRunner,
  store: ManifestStore,
  cleaner: BucketCleaner,
): Promise<RemovalResult> {
  const preserved: string[] = [];
  const failures: RemovalFailure[] = [];
  const consumerFailure = await removeQueueConsumer(manifest, runner);
  if (consumerFailure) failures.push(consumerFailure);
  const operations: Array<{
    key: "worker" | "container" | "queue" | "deadLetterQueue" | "bucket";
    args: string[];
  }> = [
    {
      key: "worker",
      args: ["delete", manifest.worker.name, "--force"],
    },
    // The container application goes after the Worker, thus no Durable Object starts a container during removal.
    { key: "container", args: [] },
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
    if (!current) continue;
    const label = `${operation.key} ${current.name}`;
    if (!current.owned) {
      preserved.push(label);
      continue;
    }
    if (current.status === "removed" || current.status === "pending") continue;
    if (operation.key === "worker" && consumerFailure) continue;
    try {
      // R2 refuses to delete a bucket that still has objects.
      if (operation.key === "bucket") await cleaner.empty(manifest.account.id, current.name);
      if (operation.key === "container") await removeContainer(manifest, runner, current.name);
      else await runner.run(command(operation.args, manifest.account.id));
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
