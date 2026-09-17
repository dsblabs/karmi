import { decodeDoctorManifest, decodeWranglerConfig, runChecks, type Finding } from "@karmi/core";
import { describe, expect, it } from "vitest";
import config from "../wrangler.jsonc?raw";
import entry from "../src/worker.ts?raw";
import { concierge } from "../src/catalogue";
import { karmi } from "./worker";

// `karmi doctor` reads wrangler.jsonc from the command line; the checks that need what this Deployment
// defines in code run here, where the real Catalogue and Agent Specs exist.
const manifest = decodeDoctorManifest({
  origin: "https://agents.example.com",
  catalogue: karmi.catalogue.describe(),
  specs: { "src/catalogue.ts": concierge.spec },
  defaults: { providers: { default: { adapter: "anthropic" } } },
});

const of = (findings: Finding[], check: string) => findings.filter((finding) => finding.check === check);

describe("karmi doctor", () => {
  it("passes every check against this project", async () => {
    const findings = await runChecks({
      config: decodeWranglerConfig(config),
      entry,
      manifest,
    });
    expect(of(findings, "specs").map((finding) => finding.status)).toEqual(["pass"]);
    expect(of(findings, "gateway").map((finding) => finding.status)).toEqual(["pass"]);
    expect(of(findings, "mcp").map((finding) => finding.status)).toEqual(["pass"]);
    expect(findings.filter((finding) => finding.status === "fail")).toEqual([]);
  });

  it("catches an Agent that names a Tool nobody defines", async () => {
    const wrong = { ...concierge.spec, tools: ["wether"] };
    const findings = await runChecks({
      config: decodeWranglerConfig(config),
      manifest: { ...manifest, specs: { "wrong.json": wrong } },
    });
    expect(of(findings, "specs")[0]?.message).toContain('tool "wether"');
  });
});
