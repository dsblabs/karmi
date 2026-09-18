import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = mkdtempSync(join(tmpdir(), "karmi-bundle-"));

try {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deploy", "--dry-run", "--config", "test/wrangler.jsonc", "--outdir", output],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Wrangler could not build the test Worker.");
  const bundle = readFileSync(join(output, readdirSync(output).find((file) => file.endsWith(".js"))), "utf8");
  const nodeImports = [...bundle.matchAll(/(?:from\s+|importAtRuntime\()["'](node:[^"']+)/g)].map(
    ([, specifier]) => specifier,
  );
  const existingImports = ["node:fs/promises", "node:path/posix"];
  if (JSON.stringify(nodeImports.sort()) !== JSON.stringify(existingImports))
    throw new Error(`The Worker bundle's node:* imports changed: ${nodeImports.join(", ") || "none"}.`);
} finally {
  rmSync(output, { force: true, recursive: true });
}
