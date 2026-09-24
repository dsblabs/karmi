import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import {
  buildCloudflareConfig,
  FileManifestStore,
  readBaseConfig,
  readManifest,
  WranglerRunner,
  writeCloudflareConfig,
} from "./cloudflare.ts";
import {
  addContainerScripts,
  addVectorRetrieval,
  createManifest,
  decodeAccounts,
  deploy,
  parseDeploymentArguments,
  recordGateway,
  selectAccount,
  type DeploymentManifest,
  type SuppliedResources,
} from "./deployment.ts";
import { parseDevVars } from "./cli.ts";

/** Stops before any resource exists when container Scripts are selected and Docker does not answer. */
function requireDocker(): void {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) return;
  throw new Error(
    "Container Scripts need Docker, which builds the image. Start Docker, then run pnpm run deploy again.",
  );
}

/** The variables of `.dev.vars` that hold the Provider selections of setup. None of them is a secret. */
const PROVIDER_VARIABLES = [
  "PLAYGROUND_PROVIDER",
  "PLAYGROUND_MODEL",
  "PLAYGROUND_BASE_URL",
  "PLAYGROUND_SECOND_PROVIDER",
  "PLAYGROUND_SECOND_MODEL",
  "PLAYGROUND_SECOND_BASE_URL",
  "PLAYGROUND_GATEWAY_ACCOUNT",
  "PLAYGROUND_GATEWAY_ID",
] as const;

const isYes = (answer: string) => /^y(es)?$/i.test(answer.trim());

function validName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function requireLocalSetup(local: Record<string, string>): void {
  const required = ["PLAYGROUND_PROVIDER", "PLAYGROUND_MODEL", "PROVIDER_API_KEY", "PLAYGROUND_TOKEN", "KARMI_KEYRING"];
  if (required.some((name) => !local[name])) throw new Error("Run `pnpm setup` before you deploy.");
}

async function createNewManifest(
  name: string,
  supplied: SuppliedResources,
  terminal: ReturnType<typeof createInterface>,
  runner: WranglerRunner,
): Promise<DeploymentManifest> {
  let whoami: string;
  try {
    whoami = await runner.run({ args: ["whoami", "--json"] });
  } catch (loginError) {
    console.log("Cloudflare login is required. Follow the Wrangler login instructions.");
    await runner.run({ args: ["login"], interactive: true });
    whoami = await runner.run({ args: ["whoami", "--json"] }).catch((error: unknown) => {
      throw new Error("Cloudflare login did not complete.", { cause: error ?? loginError });
    });
  }
  const accounts = decodeAccounts(JSON.parse(whoami));
  if (accounts.length === 0) throw new Error("Your Cloudflare login has no accounts.");
  console.log("\nSelect the Cloudflare account that will own this deployment:");
  accounts.forEach((account, index) => console.log(`  ${String(index + 1)}. ${account.name} (${account.id})`));
  let account;
  while (!account) account = selectAccount(accounts, await terminal.question("Account: "));
  console.log("\nThe base deployment creates one Worker, two Queues and one R2 bucket.");
  console.log("It does not create optional services.");
  console.log("\nThe isolate Scripts scenario needs Dynamic Workers, which need the Workers Paid plan.");
  console.log("The Worker then gets a Worker Loader binding. It creates no other resource.");
  const scripts = await terminal.question("Enable isolate Scripts? [y/N]: ");
  return createManifest(name, account, supplied, {
    isolateScripts: isYes(scripts),
    containerScripts: await askContainerScripts(terminal),
    // A supplied index selects vector retrieval, thus the question is only for an index that the deploy creates.
    vectorRetrieval: supplied.vectorIndex !== undefined || (await askVectorRetrieval(terminal)),
  });
}

/** Tells what vector retrieval needs before it asks for it, because it creates a resource and calls billed services. */
async function askVectorRetrieval(terminal: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log("\nThe vector retrieval scenario needs Workers AI, which embeds the text, and a Vectorize index.");
  console.log("Both are on the Workers Free and Paid plans. Cloudflare bills the use above the free allocation.");
  console.log("A yes creates one Vectorize index with 1024 dimensions, the cosine metric and two metadata indexes.");
  console.log("The Worker then gets a Workers AI binding, which creates no resource. Removal deletes the index.");
  console.log("Local development has no Workers AI or Vectorize, thus the scenario runs only in this deployment.");
  return isYes(await terminal.question("Enable vector retrieval? [y/N]: "));
}

/** Tells what container Scripts need before it asks for them, because they create a billed resource. */
async function askContainerScripts(terminal: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log("\nThe container Scripts scenario needs Cloudflare Containers, which need the Workers Paid plan.");
  console.log("Wrangler builds the container image on this computer, thus Docker must run here.");
  console.log("The image is for linux/amd64. On an ARM computer, Docker needs AMD64 emulation.");
  console.log("A yes creates one container application and pushes its image to the Cloudflare registry.");
  console.log("Each container that runs is billed by Cloudflare. Removal deletes the application and its images.");
  return isYes(await terminal.question("Enable container Scripts? [y/N]: "));
}

/**
 * Tells what a recorded deployment has, and asks for each optional service that it does not have yet. A deployment
 * can add them later, for example one made before the option existed. A supplied index adds vector retrieval.
 */
async function resumeManifest(
  recorded: DeploymentManifest,
  supplied: SuppliedResources,
  terminal: ReturnType<typeof createInterface>,
): Promise<DeploymentManifest> {
  let manifest = recorded;
  const options = [
    manifest.isolateScripts && "isolate Scripts",
    manifest.container && "container Scripts",
    manifest.vectorIndex && "vector retrieval",
  ];
  const selected = options.filter(Boolean).join(" and ");
  console.log(`Resume ${manifest.name} in ${manifest.account.name}${selected ? `, with ${selected}` : ""}.`);
  if (!manifest.container && (await askContainerScripts(terminal))) manifest = addContainerScripts(manifest);
  const { vectorIndex } = supplied;
  if (!manifest.vectorIndex && (vectorIndex !== undefined || (await askVectorRetrieval(terminal))))
    manifest = addVectorRetrieval(manifest, vectorIndex);
  return manifest;
}

async function main(): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const runner = new WranglerRunner();
  try {
    const local = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
    requireLocalSetup(local);
    const defaultName = `karmi-playground-${crypto.randomUUID().slice(0, 8)}`;
    const arguments_ = parseDeploymentArguments(process.argv.slice(2));
    const answer = arguments_.name ? "" : (await terminal.question(`Deployment name [${defaultName}]: `)).trim();
    const name = arguments_.name ?? (answer || defaultName);
    if (!validName(name)) throw new Error("Use 1-63 lowercase letters, numbers or hyphens for the deployment name.");
    const directory = new URL(`../.deployments/${name}/`, import.meta.url);
    const manifestFile = new URL("manifest.json", directory);
    const configFile = new URL("wrangler.json", directory);
    let manifest;
    try {
      manifest = await resumeManifest(await readManifest(manifestFile), arguments_.supplied, terminal);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
      manifest = await createNewManifest(name, arguments_.supplied, terminal, runner);
    }
    if (manifest.container) requireDocker();
    // The operator supplies the AI Gateway to setup. The manifest records it as external, thus removal keeps it.
    manifest = recordGateway(manifest, local.PLAYGROUND_GATEWAY_ID);
    // The Provider selections of setup. Each value that setup did not write stays out.
    const setupVariables = Object.fromEntries(
      PROVIDER_VARIABLES.flatMap((name) => (local[name] ? [[name, local[name]]] : [])),
    );
    const variables = {
      ...setupVariables,
      // The Worker offers container Scripts only when this variable names where the containers run.
      ...(manifest.container && { PLAYGROUND_CONTAINERS: "cloudflare" }),
      // The OAuth Connections of the MCP scenario need the public origin, which an earlier deploy recorded.
      ...(manifest.origin && { PLAYGROUND_ORIGIN: manifest.origin }),
    };
    const base = await readBaseConfig();
    await writeCloudflareConfig(configFile, buildCloudflareConfig(base, manifest, variables));
    const secrets = {
      PROVIDER_API_KEY: local.PROVIDER_API_KEY ?? "",
      ...(local.SECOND_PROVIDER_API_KEY && { SECOND_PROVIDER_API_KEY: local.SECOND_PROVIDER_API_KEY }),
      ...(local.GATEWAY_TOKEN && { GATEWAY_TOKEN: local.GATEWAY_TOKEN }),
      PLAYGROUND_TOKEN: local.PLAYGROUND_TOKEN ?? "",
      KARMI_KEYRING: local.KARMI_KEYRING ?? "",
    };
    const store = new FileManifestStore(manifestFile);
    let address = await deploy(manifest, secrets, configFile.pathname, runner, store);
    // Wrangler reports the workers.dev address only after the first deploy. A second deploy gives it to the Worker.
    if (address && address !== variables.PLAYGROUND_ORIGIN) {
      console.log(`\nDeploy again with PLAYGROUND_ORIGIN ${address}, which OAuth Connections need.`);
      const withOrigin = { ...variables, PLAYGROUND_ORIGIN: address };
      await writeCloudflareConfig(configFile, buildCloudflareConfig(base, manifest, withOrigin));
      address = await deploy(manifest, secrets, configFile.pathname, runner, store);
    }
    console.log(`\nDeployed ${name}${address ? ` at ${address}` : ""}.`);
    console.log(`Keep .deployments/${name}/manifest.json until you remove the deployment.`);
  } finally {
    terminal.close();
  }
}

await main();
