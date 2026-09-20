import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const guideDirectory = join(repositoryRoot, "docs", "guide");
const cacheDirectory = join(repositoryRoot, ".turbo");

function extractTypeScriptSamples(markdown, fileName) {
  const lines = markdown.split(/\r?\n/);
  const samples = [];
  let fenceStart;
  let sampleNumber = 0;

  for (const [lineIndex, line] of lines.entries()) {
    if (fenceStart === undefined) {
      if (/^\s*```ts\s*$/.test(line)) {
        fenceStart = lineIndex + 1;
      }
      continue;
    }

    if (/^\s*```\s*$/.test(line)) {
      sampleNumber += 1;
      samples.push({
        code: lines.slice(fenceStart, lineIndex).join("\n"),
        fileName,
        line: fenceStart + 1,
        sampleNumber,
      });
      fenceStart = undefined;
    }
  }

  if (fenceStart !== undefined) {
    throw new Error(`${fileName}:${fenceStart} has an unclosed TypeScript code block.`);
  }

  return samples;
}

const samples = readdirSync(guideDirectory)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .flatMap((fileName) => extractTypeScriptSamples(readFileSync(join(guideDirectory, fileName), "utf8"), fileName));

if (samples.length === 0) {
  console.log("No TypeScript guide samples found.");
  process.exit(0);
}

mkdirSync(cacheDirectory, { recursive: true });
const sampleDirectory = mkdtempSync(join(cacheDirectory, "karmi-doc-samples-"));

try {
  const supportFile = join(sampleDirectory, "env.d.ts");
  writeFileSync(
    supportFile,
    `declare namespace Cloudflare {
  interface Env {
    AI_GATEWAY_URL: string;
    ANTHROPIC_API_KEY: string;
    API_TOKEN: string;
    KNOWLEDGE_VECTORS_BGE_M3: Vectorize;
  }
}
`,
  );
  writeFileSync(
    join(sampleDirectory, "worker.ts"),
    `import { createTestKarmi } from "@karmi/core/testing";

export const { clock, provider, scope } = createTestKarmi({ agents: [] });
`,
  );
  const typeScriptConfig = join(sampleDirectory, "tsconfig.json");
  writeFileSync(
    typeScriptConfig,
    `${JSON.stringify(
      {
        extends: join(repositoryRoot, "tsconfig.base.json"),
        compilerOptions: {
          declaration: false,
          noEmit: true,
          types: ["@cloudflare/workers-types"],
        },
        include: ["./*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  for (const { code, fileName, line, sampleNumber } of samples) {
    const sampleFile = join(sampleDirectory, `${basename(fileName, ".md")}-sample-${sampleNumber}-line-${line}.ts`);
    writeFileSync(sampleFile, `${code}\n`);
  }

  execFileSync(
    process.execPath,
    [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "--project", typeScriptConfig],
    { cwd: repositoryRoot, stdio: "inherit" },
  );

  console.log(`Checked ${samples.length} TypeScript guide samples.`);
} finally {
  rmSync(sampleDirectory, { force: true, recursive: true });
}
