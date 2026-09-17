#!/usr/bin/env node
import { parseArgs } from "node:util";
import { scaffold } from "./index";

const USAGE = `pnpm create karmi <directory> [options]

  --name <name>  The project, Worker, Queue and bucket name. Defaults to the directory's name.

Writes a karmi project and stops there: install and deploy it yourself.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { name: { type: "string" }, help: { type: "boolean" } },
  });
  const [directory] = positionals;
  if (values.help || directory === undefined || positionals.length > 1) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 1;
  } else {
    const project = await scaffold({ directory, ...(values.name !== undefined && { name: values.name }) });
    console.log(`Created ${project.name} in ${directory} (${project.files.length} files, karmi ${project.version}).

  cd ${directory}
  pnpm install
  pnpm typecheck && pnpm test

Then read the README for what to create in your Cloudflare account before the first deploy.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
