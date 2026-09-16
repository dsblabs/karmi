#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse, printParseErrorCode } from "jsonc-parser";
import { decodeDoctorManifest, decodeWranglerConfig, formatFindings, hasFailure, runChecks } from "../dist/doctor.js";

const USAGE = `karmi doctor [options]

  --config <path>    The wrangler configuration to check. Defaults to wrangler.jsonc.
  --binding <name>   The Vectorize binding to inspect. Defaults to KARMI_VECTORIZE.
  --manifest <path>  What the Deployment defines in code, as JSON: { catalogue, specs, defaults, origin }.
                     Defaults to karmi.doctor.json when it exists.
  --dims <n>         The embedding dimensions that index must have. Defaults to 1024.
  --metric <name>    Its distance metric: cosine, euclidean or dot-product. Defaults to cosine.

CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN enable the Vectorize check.
Exits 1 when any check fails; warnings and skipped checks exit 0.`;

/** Reads a file as text. Throws with the path in the message. */
async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
}

/** Parses a JSON with Comments file, or returns undefined when `optional` and the file is absent. */
async function readJsonc(path, optional = false) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(`${path} is not valid JSON: ${errors.map((e) => printParseErrorCode(e.error)).join(", ")}`);
  return value;
}

async function doctor(values) {
  const config = decodeWranglerConfig(await readText(values.config));
  const entry = config.main
    ? await readFile(resolve(dirname(values.config), config.main), "utf8").catch(() => undefined)
    : undefined;
  const manifestPath = values.manifest ?? "karmi.doctor.json";
  const document = await readJsonc(manifestPath, values.manifest === undefined);
  const findings = await runChecks({
    config,
    ...(entry !== undefined && { entry }),
    ...(document !== undefined && { manifest: decodeDoctorManifest(document) }),
    ...(process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_API_TOKEN && {
        cloudflare: {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
        },
      }),
    index: { dims: Number(values.dims), metric: values.metric },
    vectorizeBinding: values.binding,
  });
  console.log(formatFindings(findings));
  if (hasFailure(findings)) {
    console.error("\nkarmi doctor found problems that will break a deploy.");
    process.exitCode = 1;
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "wrangler.jsonc" },
      binding: { type: "string", default: "KARMI_VECTORIZE" },
      manifest: { type: "string" },
      dims: { type: "string", default: "1024" },
      metric: { type: "string", default: "cosine" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(USAGE);
  else if (positionals.length !== 1 || positionals[0] !== "doctor") throw new Error(USAGE);
  else if (!Number.isInteger(Number(values.dims)) || Number(values.dims) < 1)
    throw new Error("--dims must be a positive integer.");
  else if (!["cosine", "euclidean", "dot-product"].includes(values.metric))
    throw new Error("--metric must be cosine, euclidean or dot-product.");
  else await doctor(values);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
