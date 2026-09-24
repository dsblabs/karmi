import { decodeWranglerConfig, formatFindings, hasFailure, runChecks } from "@karmi/core";
import { describe, expect, it } from "vitest";
import brokenConfig from "../walkthroughs/missing-migration.wrangler.jsonc?raw";
import config from "../wrangler.jsonc?raw";
import entry from "../src/worker.ts?raw";
import packageJson from "../package.json";
import { OPERATIONS_WALKTHROUGH, RECORDING_FILE } from "../src/walkthroughs";

// Checks that the commands of the operations walkthrough still run as the walkthrough tells. `karmi doctor` runs
// the same checks as `runChecks`, thus the test compares the lines that the command prints.

const step = (title: string) => {
  const found = OPERATIONS_WALKTHROUGH.find((item) => item.title === title);
  if (!found) throw new Error(`The walkthrough has no step "${title}".`);
  return found;
};

const doctorLines = async (source: string) => {
  const findings = await runChecks({ config: decodeWranglerConfig(source), entry });
  return { lines: formatFindings(findings), failed: hasFailure(findings) };
};

// The test files that exist, by the path that a command gives, for example `test/replay.test.ts`.
const testFiles = Object.keys(import.meta.glob("./*.test.ts")).map((path) => path.replace("./", "test/"));
const recordings = Object.keys(import.meta.glob("./recordings/*.jsonl")).map((path) => path.replace("./", "test/"));

describe("the operations walkthrough", () => {
  it("prints the doctor lines of the Playground configuration, with no failure", async () => {
    const { lines, failed } = await doctorLines(config);
    expect(lines).toBe(step("Check the configuration with karmi doctor").output);
    expect(failed).toBe(false);
  });

  it("prints the FAIL line of the broken copy, and the command exits with code 1", async () => {
    const { lines, failed } = await doctorLines(brokenConfig);
    const { output } = step("Diagnose a configuration failure");
    expect(output).toBe(`${lines}\n\nkarmi doctor found problems that will break a deploy.`);
    expect(failed).toBe(true);
  });

  it("keeps the broken copy equal to wrangler.jsonc, except for the one migration and the relative paths", () => {
    const { migrations, ...broken } = decodeWranglerConfig(brokenConfig);
    const { migrations: real, ...working } = decodeWranglerConfig(config);
    expect({ ...broken, main: working.main }).toEqual(working);
    expect(migrations).toEqual(real?.filter((migration) => migration.tag !== "karmi-v3"));
  });

  it("names only scripts of package.json and files that exist", () => {
    const scripts = Object.keys(packageJson.scripts);
    const commands = OPERATIONS_WALKTHROUGH.flatMap((item) => item.commands.split("\n")).filter(
      (line) => !line.startsWith("#"),
    );
    for (const command of commands) {
      const [tool, first, second] = command.split(" ");
      expect(tool).toBe("pnpm");
      if (first === "exec") expect(second).toBe("karmi");
      else expect(scripts).toContain(first === "run" ? second : first);
      if (first === "test" && second) expect(testFiles).toContain(second);
    }
    expect(recordings).toContain(RECORDING_FILE);
  });
});
