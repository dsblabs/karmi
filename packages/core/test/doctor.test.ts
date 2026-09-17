import { describe, expect, it } from "vitest";
import baselineSource from "../wrangler.baseline.jsonc?raw";
import {
  checkBindings,
  checkCapabilities,
  checkCompatibility,
  checkDurableObjects,
  checkGatewayDefer,
  checkMcp,
  checkSpecs,
  checkVectorize,
  decodeDoctorManifest,
  decodeWranglerConfig,
  exportedNames,
  formatFindings,
  hasFailure,
  runChecks,
  type Finding,
  type WranglerConfig,
} from "../src/doctor";
import { KarmiError } from "../src/errors";

const baseline = decodeWranglerConfig(baselineSource);
const entry = "export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;";

const statuses = (findings: Finding[]) => findings.map((finding) => finding.status);
const messages = (findings: Finding[]) => findings.map((finding) => finding.message).join("\n");
const withConfig = (patch: Partial<WranglerConfig>): WranglerConfig => ({ ...baseline, ...patch });

const spec = {
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "Help the guest." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather"],
};
const description = {
  deliverers: [],
  tools: [{ name: "weather", description: "Weather", annotations: {}, input: {} }],
  fragments: [{ name: "guest" }],
  skills: [{ name: "research", description: "Research", tools: ["search"], invokableBy: "model" }],
  retrievers: [],
  hooks: [{ name: "observe", point: "after-tool" }],
  agents: [{ agentId: "concierge", name: "Concierge" }],
};

describe("the wrangler baseline", () => {
  it("passes every check it can answer", async () => {
    const findings = await runChecks({ config: baseline, entry });
    expect(hasFailure(findings)).toBe(false);
    expect(statuses(findings)).not.toContain("warn");
  });

  it("refuses a config that is not JSON, and one whose fields karmi reads are malformed", () => {
    expect(() => decodeWranglerConfig("{ oops")).toThrowError(KarmiError);
    expect(() => decodeWranglerConfig('{ "migrations": [{ "tag": 7 }] }')).toThrowError(KarmiError);
  });
});

describe("the compatibility check", () => {
  it("fails a missing or malformed date", () => {
    expect(statuses(checkCompatibility(withConfig({ compatibility_date: undefined })))).toEqual(["fail"]);
    expect(statuses(checkCompatibility(withConfig({ compatibility_date: "soon" })))).toEqual(["fail"]);
  });

  it("fails a date below the floor and names it", () => {
    const findings = checkCompatibility(withConfig({ compatibility_date: "2026-08-03" }));
    expect(statuses(findings)).toEqual(["fail"]);
    expect(messages(findings)).toContain("2026-08-04");
  });

  it("warns when the SSRF-hardening flag is missing", () => {
    const findings = checkCompatibility(withConfig({ compatibility_flags: [] }));
    expect(statuses(findings)).toEqual(["pass", "warn"]);
    expect(messages(findings)).toContain("global_fetch_strictly_public");
  });
});

describe("the bindings check", () => {
  it("fails each missing Durable Object binding", () => {
    const findings = checkBindings(withConfig({ durable_objects: { bindings: [] } }));
    expect(findings.filter((finding) => finding.status === "fail")).toHaveLength(3);
    expect(messages(findings)).toContain("KARMI_THREADS");
  });

  it("warns about a KARMI_ name that is not a karmi binding", () => {
    const findings = checkBindings(withConfig({ r2_buckets: [{ binding: "KARMI_MEDIAS" }] }));
    expect(messages(findings)).toContain("KARMI_MEDIAS");
    expect(statuses(findings)).toContain("warn");
  });

  it("warns when the karmi queue has no consumer", () => {
    const queues = { producers: [{ binding: "KARMI_QUEUE", queue: "q" }] };
    expect(messages(checkBindings(withConfig({ queues })))).toContain("no consumer");
  });

  it("warns when there is no media bucket", () => {
    expect(messages(checkBindings(withConfig({ r2_buckets: [] })))).toContain("KARMI_MEDIA");
  });
});

describe("the Durable Object check", () => {
  it("reads the names a module exports", () => {
    expect([...exportedNames("export const { A, B: C } = x;\nexport { D as E };\nexport class F {}")]).toEqual([
      "A",
      "C",
      "E",
      "F",
    ]);
  });

  it("fails a class the entry does not re-export", () => {
    const findings = checkDurableObjects(baseline, "export const { ThreadDO } = karmi.durableObjects;");
    expect(findings.filter((finding) => finding.status === "fail")).toHaveLength(3);
    expect(messages(findings)).toContain("ScopeConfigDO");
  });

  it("skips the re-export half when the entry cannot be read", () => {
    expect(statuses(checkDurableObjects(baseline, undefined))).toEqual(["skip"]);
  });

  it("fails a class with no migration, and one migrated without SQLite", () => {
    const migrations = [{ tag: "v1", new_classes: ["ThreadDO"] }];
    const findings = checkDurableObjects(withConfig({ migrations }), entry);
    expect(messages(findings)).toContain("new_sqlite_classes");
    expect(findings.filter((finding) => finding.status === "fail")).toHaveLength(4);
  });
});

describe("the capabilities check", () => {
  it("reports the isolate tier as unavailable without a Worker loader", () => {
    expect(statuses(checkCapabilities(baseline))).toEqual(["skip", "skip"]);
  });

  it("reports both tiers when both are configured", () => {
    const config = withConfig({
      worker_loaders: [{ binding: "KARMI_LOADER" }],
      durable_objects: { bindings: [{ name: "KARMI_SANDBOX", class_name: "KarmiSandbox" }] },
      containers: [{ class_name: "KarmiSandbox", image: "./Dockerfile" }],
    });
    expect(statuses(checkCapabilities(config))).toEqual(["pass", "pass"]);
  });
});

describe("the Vectorize check", () => {
  const config = withConfig({ vectorize: [{ binding: "KARMI_VECTORIZE", index_name: "karmi" }] });

  it("skips when the named binding is absent", async () => {
    expect(statuses(await checkVectorize({ config: baseline }))).toEqual(["skip"]);
    expect(messages(await checkVectorize({ config, vectorizeBinding: "OTHER" }))).toContain("No OTHER binding");
  });

  it("skips when there are no API credentials", async () => {
    expect(messages(await checkVectorize({ config }))).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("fails when the index does not match the embedding model", async () => {
    const respond = (body: unknown) => Promise.resolve(Response.json(body));
    const findings = await checkVectorize({
      config,
      cloudflare: { accountId: "a", apiToken: "t" },
      fetch: ((url: string) =>
        url.endsWith("/metadata_index/list")
          ? respond({ success: true, result: { metadataIndexes: [] } })
          : respond({ success: true, result: { config: { dimensions: 768, metric: "cosine" } } })) as typeof fetch,
    });
    expect(statuses(findings)).toEqual(["fail"]);
    expect(messages(findings)).toContain("768/cosine");
  });
});

describe("the gateway check", () => {
  const gateway = { kind: "cloudflare", accountId: "a", gatewayId: "g" };
  const defaults = { providers: { default: { gateway } } };

  it("skips without the inputs it needs, and says which one is missing", () => {
    expect(messages(checkGatewayDefer(undefined))).toContain("createKarmi defaults");
    expect(messages(checkGatewayDefer({ defaults }))).toContain("no Agent Spec");
  });

  it("warns when a gateway meets an Agent that defers its Tools", () => {
    const findings = checkGatewayDefer({ defaults, specs: { "concierge.json": spec } });
    expect(statuses(findings)).toEqual(["warn"]);
    expect(messages(findings)).toContain("concierge.json");
  });

  it("passes when every Agent turns deferral off", () => {
    const never = { ...spec, context: { tools: { defer: "never" } } };
    expect(statuses(checkGatewayDefer({ defaults, specs: { "a.json": never } }))).toEqual(["pass"]);
  });

  it("passes when no profile runs through a gateway", () => {
    const findings = checkGatewayDefer({ defaults: { providers: {} }, specs: { "a.json": spec } });
    expect(statuses(findings)).toEqual(["pass"]);
  });
});

describe("the MCP check", () => {
  const server = (url: string, auth: unknown) => ({ defaults: { mcp: { servers: { s: { url, auth } } } } });

  it("passes when no server uses OAuth", () => {
    expect(statuses(checkMcp(server("https://mcp.example.com", { type: "none" })))).toEqual(["pass"]);
  });

  it("warns when the Deployment has no OAuth origin", () => {
    const findings = checkMcp(server("https://mcp.example.com", { type: "oauth", level: "user" }));
    expect(messages(findings)).toContain("createKarmi({ oauth: { origin } })");
  });

  it("names the vendor, its registration page and the exact callback URL", () => {
    const findings = checkMcp({
      ...server("https://mcp.slack.com/mcp", { type: "oauth", level: "user" }),
      origin: "https://agents.example.com",
    });
    expect(statuses(findings)).toEqual(["warn"]);
    expect(messages(findings)).toContain("https://api.slack.com/apps");
    expect(messages(findings)).toContain("https://agents.example.com/mcp/oauth/callback");
  });

  it("stays quiet once the pre-registered client is configured", () => {
    const auth = { type: "oauth", level: "user", client: { id: "my-app" } };
    const findings = checkMcp({ ...server("https://mcp.slack.com/mcp", auth), origin: "https://a.example.com" });
    expect(statuses(findings)).toEqual(["pass"]);
  });
});

describe("the Agent Spec check", () => {
  it("skips when the manifest lists no Specs", () => {
    expect(statuses(checkSpecs({}))).toEqual(["skip"]);
  });

  it("fails a Spec whose shape is wrong, at its path", () => {
    const findings = checkSpecs({ specs: { "bad.json": { ...spec, model: {} } }, catalogue: description });
    expect(statuses(findings)).toEqual(["fail"]);
    expect(messages(findings)).toContain("/model/id");
  });

  it("names every dangling reference", () => {
    const dangling = {
      ...spec,
      instructions: [{ fragment: "missing-fragment" }],
      tools: ["weather", "nope", "mcp:github", "tool_search"],
      skills: ["research", "gone"],
      delegates: ["concierge", "ghost"],
      hooks: { "after-tool": ["observe", "absent"] },
      knowledge: [{ name: "docs", retriever: "elsewhere" }],
    };
    const findings = checkSpecs({ specs: { "a.json": dangling }, catalogue: description });
    expect(findings.map((finding) => finding.message)).toEqual([
      'a.json references tool "nope", which the Catalogue does not define.',
      'a.json references skill "gone", which the Catalogue does not define.',
      'a.json references agent "ghost", which the Catalogue does not define.',
      'a.json references hook "absent", which the Catalogue does not define.',
      'a.json references fragment "missing-fragment", which the Catalogue does not define.',
      'a.json references retriever "elsewhere", which the Catalogue does not define.',
    ]);
  });

  it("resolves a Skill's own Tools and the built-ins", () => {
    const allowed = { ...spec, tools: ["weather", "search", "remember"], skills: ["research"] };
    expect(statuses(checkSpecs({ specs: { "a.json": allowed }, catalogue: description }))).toEqual(["pass"]);
  });

  it("skips reference resolution without a Catalogue description", () => {
    expect(statuses(checkSpecs({ specs: { "a.json": spec } }))).toEqual(["skip"]);
  });
});

describe("the report", () => {
  it("refuses a malformed manifest", () => {
    expect(() => decodeDoctorManifest({ specs: [] })).toThrowError(KarmiError);
    expect(() => decodeDoctorManifest({ catalogue: { tools: "all" } })).toThrowError(KarmiError);
  });

  it("reads a Catalogue description that defines nothing", () => {
    const manifest = decodeDoctorManifest({ catalogue: {}, specs: { "a.json": spec } });
    expect(messages(checkSpecs(manifest))).toContain('tool "weather"');
  });

  it("marks each line with its status", () => {
    const findings: Finding[] = [
      { check: "bindings", status: "pass", message: "Fine." },
      { check: "mcp", status: "fail", message: "Broken." },
    ];
    expect(formatFindings(findings)).toBe("ok   bindings: Fine.\nFAIL mcp: Broken.");
    expect(hasFailure(findings)).toBe(true);
  });
});
