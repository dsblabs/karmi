// The recording step of the operations walkthrough: `pnpm record [origin]`. It reads the calls of the front desk
// Agent from a Worker that `pnpm dev:record` started, and writes them to the recording that test/replay.test.ts
// replays. The default origin is the address of `wrangler dev`.
import { RECORDING_FILE } from "../src/walkthroughs.ts";
import { parseDevVars } from "./cli.ts";

async function main(): Promise<void> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const origin = process.argv[2] ?? "http://localhost:8787";
  const vars = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8").catch(() => ""));
  const token = vars.PLAYGROUND_TOKEN;
  if (!token) throw new Error("`.dev.vars` has no PLAYGROUND_TOKEN. Run `pnpm setup` first.");
  const response = await fetch(`${origin}/api/recording`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404)
    throw new Error("The Worker records no Provider calls. Start it with `pnpm dev:record`.");
  if (!response.ok) throw new Error(`The Worker answered with HTTP ${String(response.status)}.`);
  const jsonl = await response.text();
  const calls = jsonl.split("\n").filter((line) => line.trim() !== "").length;
  if (calls === 0)
    throw new Error(
      "The Worker has no call of the front desk Agent. Run a prompt in the REST, SSE and WebSocket scenario.",
    );
  const file = new URL(`../${RECORDING_FILE}`, import.meta.url);
  await mkdir(new URL(".", file), { recursive: true });
  await writeFile(file, jsonl);
  console.log(`Saved ${String(calls)} call${calls === 1 ? "" : "s"} of the front desk Agent to ${RECORDING_FILE}.`);
}

await main();
