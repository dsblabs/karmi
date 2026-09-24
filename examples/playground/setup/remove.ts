import { CloudflareBucketCleaner, FileManifestStore, readManifest, WranglerRunner } from "./cloudflare.ts";
import { remove } from "./deployment.ts";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) throw new Error("Give the deployment name: `pnpm run remove <name>`. ");
  const manifestFile = new URL(`../.deployments/${name}/manifest.json`, import.meta.url);
  const manifest = await readManifest(manifestFile);
  const runner = new WranglerRunner();
  const result = await remove(
    manifest,
    runner,
    new FileManifestStore(manifestFile),
    new CloudflareBucketCleaner(runner),
  );
  for (const resource of result.preserved) console.log(`Preserved supplied ${resource}.`);
  // Removal cannot reach the Knowledge Durable Objects, which list the vectors that the Playground wrote.
  if (manifest.vectorIndex && !manifest.vectorIndex.owned)
    console.log(
      `The supplied index ${manifest.vectorIndex.name} keeps each vector that a reset of the vector retrieval scenario did not delete.`,
    );
  if (!result.complete) {
    console.error("Removal is incomplete. These owned resources remain:");
    for (const failure of result.failures) console.error(`- ${failure.resource}: ${failure.message}`);
    console.error(`Fix the errors and run \`pnpm run remove ${name}\` again.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Removed all resources owned by ${name}.`);
}

await main();
