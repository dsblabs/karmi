#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parse, printParseErrorCode } from "jsonc-parser";
import { checkVectorizeIndex } from "../dist/vector-doctor.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "wrangler.jsonc" },
      binding: { type: "string", default: "KARMI_VECTORIZE" },
      dims: { type: "string", default: "1024" },
      metric: { type: "string", default: "cosine" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("karmi doctor [--config wrangler.jsonc] [--binding KARMI_VECTORIZE] [--dims 1024] [--metric cosine]");
  } else {
    if (positionals.length !== 1 || positionals[0] !== "doctor") throw new Error("Usage: karmi doctor --help");
    const errors = [];
    const config = parse(await readFile(values.config, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length)
      throw new Error(`Invalid configuration: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`);
    const binding = config?.vectorize?.find((item) => item.binding === values.binding);
    if (typeof binding?.index_name !== "string")
      throw new Error(`No Vectorize binding ${values.binding} in ${values.config}.`);
    const dims = Number(values.dims);
    if (!Number.isInteger(dims) || dims < 1 || !["cosine", "euclidean", "dot-product"].includes(values.metric))
      throw new Error("Expected positive --dims and --metric cosine, euclidean or dot-product.");
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config.account_id;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken)
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to inspect the bound index.");
    await checkVectorizeIndex(binding.index_name, { dims, metric: values.metric }, { accountId, apiToken });
    console.log(`${values.binding}: dimensions, metric and metadata indexes match.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
