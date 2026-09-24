// The terminal setup of the Playground: `pnpm setup`. It asks for the Provider, the model and the credential, and
// writes them with a new access token to `.dev.vars`. Git ignores that file and `wrangler dev` reads it.
import { PROVIDER_OPTIONS, type ProviderOption } from "../src/provider-options.ts";

/** The answers of the operator. */
export interface SetupAnswers {
  option: ProviderOption;
  model: string;
  /** The Provider credential. */
  apiKey: string;
  baseUrl?: string;
}

/** The secrets that setup makes one time and keeps in later runs, so stored state stays readable. */
export interface Generated {
  /** The operator access token. */
  token: string;
  /** The `KARMI_KEYRING` JSON document. */
  keyring: string;
}

/** Returns this number of random bytes as base64 text. 32 bytes make one key of the key ring. */
export function randomBase64(bytes: number): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));
}

/** Makes a new access token and a new key ring. */
export function generate(): Generated {
  const token = randomBase64(24).replaceAll("+", "-").replaceAll("/", "_");
  return { token, keyring: JSON.stringify({ active: "v1", keys: { v1: randomBase64(32) } }) };
}

/** Reads the lines of a `.dev.vars` file into a record. It ignores comments and lines that are not valid. */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    const raw = match[2];
    vars[match[1]] = raw.length > 1 && raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return vars;
}

/**
 * Writes the content of `.dev.vars`. It keeps the token, the key ring and the public origin of `previous` when they
 * exist. Throws when a value contains a single quote or a line break.
 */
export function buildDevVars(answers: SetupAnswers, previous: Record<string, string>, fresh: Generated): string {
  const vars: Record<string, string> = {
    PLAYGROUND_PROVIDER: answers.option.id,
    PLAYGROUND_MODEL: answers.model,
    ...(answers.baseUrl && { PLAYGROUND_BASE_URL: answers.baseUrl }),
    PROVIDER_API_KEY: answers.apiKey,
    PLAYGROUND_TOKEN: previous.PLAYGROUND_TOKEN || fresh.token,
    KARMI_KEYRING: previous.KARMI_KEYRING || fresh.keyring,
    // The operator adds the public origin by hand for OAuth in local development. Setup keeps it.
    ...(previous.PLAYGROUND_ORIGIN && { PLAYGROUND_ORIGIN: previous.PLAYGROUND_ORIGIN }),
  };
  // wrangler reads a value in single quotes with no change. In double quotes, it would keep each `\"` of the key ring.
  const lines = Object.entries(vars).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new Error(`${name} cannot contain a single quote or a line break.`);
    return `${name}='${value}'`;
  });
  return `# Written by \`pnpm setup\`. Do not commit this file.\n${lines.join("\n")}\n`;
}

/** Finds the option for a menu answer: a number from 1, or an id. */
export function chooseOption(answer: string): ProviderOption | undefined {
  const text = answer.trim().toLowerCase();
  return PROVIDER_OPTIONS[Number(text) - 1] ?? PROVIDER_OPTIONS.find((option) => option.id === text);
}

async function main(): Promise<void> {
  const { createInterface } = await import("node:readline/promises");
  const { chmod, readFile, writeFile } = await import("node:fs/promises");
  const file = new URL("../.dev.vars", import.meta.url);
  const terminal = createInterface({ input: process.stdin });
  // The line iterator also works when the answers come from a pipe, which `question` does not.
  const lines = terminal[Symbol.asyncIterator]();
  const ask = async (question: string, fallback?: string): Promise<string> => {
    for (;;) {
      process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      const line = await lines.next();
      if (line.done) throw new Error("Setup stopped before it had each answer. It wrote no file.");
      const answer = line.value.trim();
      if (answer || fallback) return answer || (fallback ?? "");
    }
  };
  try {
    console.log("karmi Playground setup\n\nWhich Provider do you use?");
    PROVIDER_OPTIONS.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
    let option: ProviderOption | undefined;
    while (!option) option = chooseOption(await ask("Provider"));
    const baseUrl = option.needsBaseUrl ? await ask("Base URL, for example https://host.example/v1") : undefined;
    const model = await ask("Model", option.defaultModel);
    // The terminal shows the credential while you type or paste it. It goes to `.dev.vars` only.
    const apiKey = await ask(`${option.label} API key`);
    const previous = parseDevVars(await readFile(file, "utf8").catch(() => ""));
    const content = buildDevVars({ option, model, apiKey, ...(baseUrl && { baseUrl }) }, previous, generate());
    await writeFile(file, content, { mode: 0o600 });
    // The mode of `writeFile` applies to a new file only.
    await chmod(file, 0o600);
    console.log(`\nWrote examples/playground/.dev.vars for ${option.label} with the model ${model}.`);
    console.log(`Your access token: ${parseDevVars(content).PLAYGROUND_TOKEN}`);
    console.log("Start the Playground with `pnpm dev`, open the URL that it prints and enter the token.");
  } finally {
    terminal.close();
  }
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("cli.ts")) await main();
