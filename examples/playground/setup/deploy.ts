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
  createManifest,
  decodeAccounts,
  deploy,
  parseDeploymentArguments,
  selectAccount,
  type DeploymentManifest,
  type SuppliedResources,
} from "./deployment.ts";
import { parseDevVars } from "./cli.ts";

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
  return createManifest(name, account, supplied);
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
      manifest = await readManifest(manifestFile);
      console.log(`Resume ${name} in ${manifest.account.name}.`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
      manifest = await createNewManifest(name, arguments_.supplied, terminal, runner);
    }
    const variables = {
      PLAYGROUND_PROVIDER: local.PLAYGROUND_PROVIDER ?? "",
      PLAYGROUND_MODEL: local.PLAYGROUND_MODEL ?? "",
      ...(local.PLAYGROUND_BASE_URL && { PLAYGROUND_BASE_URL: local.PLAYGROUND_BASE_URL }),
    };
    await writeCloudflareConfig(configFile, buildCloudflareConfig(await readBaseConfig(), manifest, variables));
    const secrets = {
      PROVIDER_API_KEY: local.PROVIDER_API_KEY ?? "",
      PLAYGROUND_TOKEN: local.PLAYGROUND_TOKEN ?? "",
      KARMI_KEYRING: local.KARMI_KEYRING ?? "",
    };
    await deploy(manifest, secrets, configFile.pathname, runner, new FileManifestStore(manifestFile));
    console.log(`\nDeployed ${name}. Wrangler printed its address above.`);
    console.log(`Keep .deployments/${name}/manifest.json until you remove the deployment.`);
  } finally {
    terminal.close();
  }
}

await main();
