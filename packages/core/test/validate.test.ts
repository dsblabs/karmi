import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_SPEC_DEFAULTS,
  AgentSpecSchema,
  agentSpecJsonSchema,
  assembleCatalogue,
  defineAgent,
  defineFragment,
  defineHook,
  defineRetriever,
  defineSkill,
  defineTool,
  ISSUE_CODES,
  KarmiError,
  validateAgentSpec,
  type AgentSpec,
  type Issue,
  type IssueCode,
  type ScopeContext,
  type ValidationResult,
} from "../src/index";

const weather = defineTool({
  name: "weather",
  description: "Current weather",
  input: z.object({ city: z.string() }),
  settings: z.object({ units: z.enum(["c", "f"]) }),
  requires: "weather_api",
  execute: () => "",
});
const echo = defineTool({
  name: "echo",
  description: "Echo",
  input: z.object({ text: z.string() }),
  execute: () => "",
});
const search = defineTool({
  name: "search",
  description: "Search",
  input: z.object({ q: z.string() }),
  requires: "search_api",
  execute: () => "",
});
const greeting = defineFragment({ name: "greeting", args: z.object({ tone: z.string() }), render: () => "" });
const plain = defineFragment({ name: "plain", render: () => "" });
const research = defineSkill({
  name: "research",
  description: "Research",
  body: () => "",
  tools: [search],
  settings: z.object({ depth: z.number() }),
});
const fts = defineRetriever({ name: "fts", search: async () => [] });
const audit = defineHook({ name: "audit", point: "after-tool", run: () => {} });
const catalogue = assembleCatalogue({
  tools: [weather, echo],
  fragments: [greeting, plain],
  skills: [research],
  retrievers: [fts],
  hooks: [audit],
});

const base: AgentSpec = {
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "Help." }],
  model: { id: "anthropic/claude-sonnet-5" },
};
const spec = (patch: Partial<AgentSpec>): AgentSpec => ({ ...base, ...patch });
// The Scope layer: a configured `default` profile, a few ceilings, and one other Agent whose Memory profile can conflict.
const helper = (memory?: AgentSpec["memory"]): ScopeContext["agents"][number] => ({
  agentId: "helper",
  spec: {
    agentId: "helper",
    name: "Helper",
    instructions: [],
    model: { id: "anthropic/claude-haiku-4-5" },
    ...(memory && { memory }),
  },
});
const scope: ScopeContext = {
  config: {
    providers: { default: { adapter: "anthropic" } },
    ceilings: { scheduling: false, longRunning: { maxSteps: 100 }, approvals: { timeout: 60_000 } },
  },
  agents: [helper({ profile: { properties: { tier: { type: "number" } } } })],
};
const validate = (s: unknown, ctx: ScopeContext = scope) => validateAgentSpec(s, catalogue, ctx);
const codesOf = (issues: Issue[]) => issues.map((i) => i.code);
const diagnostics = (result: ValidationResult): Issue[] => (result.ok ? result.warnings : result.issues);

// Every code paired with a Spec that produces it, so a new code without a test fails the coverage check below.
const cases: Record<IssueCode, { spec: unknown; path: string; severity: Issue["severity"]; ctx?: ScopeContext }> = {
  "shape.invalid-type": { spec: spec({ name: 42 as never }), path: "/name", severity: "error" },
  "shape.unknown-key": { spec: { ...base, version: 1 }, path: "", severity: "error" },
  "shape.invalid": { spec: spec({ agentId: "bad id" }), path: "/agentId", severity: "error" },
  "capability.reserved": {
    spec: spec({ capabilities: { egress: {} } as never }),
    path: "/capabilities/egress",
    severity: "error",
  },
  "capability.scripts.tool-unreferenced": {
    spec: spec({ tools: ["echo"], capabilities: { scripts: { tier: "isolate", tools: ["weather"] } } }),
    path: "/capabilities/scripts/tools/0",
    severity: "error",
  },
  "ref.tool.unknown": { spec: spec({ tools: ["nope"] }), path: "/tools/0/name", severity: "error" },
  "ref.tool.built-in": { spec: spec({ tools: ["run_script"] }), path: "/tools/0/name", severity: "error" },
  "ref.mcp.invalid": { spec: spec({ tools: ["mcp:bad/server/tool"] }), path: "/tools/0/name", severity: "error" },
  "ref.skill.unknown": { spec: spec({ skills: ["nope"] }), path: "/skills/0/name", severity: "error" },
  "ref.retriever.unknown": {
    spec: spec({ knowledge: [{ name: "faq", retriever: "nope" }] }),
    path: "/knowledge/0/retriever",
    severity: "error",
  },
  "ref.fragment.unknown": {
    spec: spec({ instructions: [{ fragment: "nope" }] }),
    path: "/instructions/0/fragment",
    severity: "error",
  },
  "ref.hook.unknown": {
    spec: spec({ hooks: { "after-tool": ["nope"] } }),
    path: "/hooks/after-tool/0",
    severity: "error",
  },
  "ref.hook.point": {
    spec: spec({ hooks: { "before-turn": ["audit"] } }),
    path: "/hooks/before-turn/0",
    severity: "error",
  },
  "ref.duplicate": { spec: spec({ tools: ["echo", { name: "echo" }] }), path: "/tools/1", severity: "error" },
  "settings.invalid": {
    spec: spec({
      tools: [{ name: "weather", settings: { units: "k" } }],
      connections: { weather_api: { type: "key", level: "agent" } },
    }),
    path: "/tools/0/settings/units",
    severity: "error",
  },
  "settings.unexpected": {
    spec: spec({ tools: [{ name: "echo", settings: { x: 1 } }] }),
    path: "/tools/0/settings",
    severity: "error",
  },
  "args.invalid": {
    spec: spec({ instructions: [{ fragment: "greeting", args: {} }] }),
    path: "/instructions/0/args/tone",
    severity: "error",
  },
  "args.unexpected": {
    spec: spec({ instructions: [{ fragment: "plain", args: { x: 1 } }] }),
    path: "/instructions/0/args",
    severity: "error",
  },
  "connection.missing": {
    spec: spec({ skills: [{ name: "research", settings: { depth: 1 } }] }),
    path: "/connections/search_api",
    severity: "error",
  },
  "connection.unused": {
    spec: spec({ connections: { crm: { type: "oauth", level: "user" } } }),
    path: "/connections/crm",
    severity: "warning",
  },
  "policy.match.empty": {
    spec: spec({ policy: [{ match: {}, effect: "allow" }] }),
    path: "/policy/0/match",
    severity: "error",
  },
  "policy.ask-on-provider-tool": {
    spec: spec({
      capabilities: { providerTools: { tools: ["web_search"] } },
      policy: [{ match: { tool: "web_*" }, effect: "ask" }],
    }),
    path: "/policy/0/effect",
    severity: "error",
  },
  "policy.tool-search-denied": {
    spec: spec({ tools: ["weather"], policy: [{ match: { tool: ["book", "tool_search"] }, effect: "deny" }] }),
    path: "/policy/0/effect",
    severity: "error",
  },
  "policy.unreferenced-tool": {
    spec: spec({ tools: ["echo"], policy: [{ match: { tool: "weather" }, effect: "deny" }] }),
    path: "/policy/0/match/tool",
    severity: "warning",
  },
  "delegation.no-capability": { spec: spec({ delegates: ["helper"] }), path: "/delegates", severity: "error" },
  "delegation.no-delegates": {
    spec: spec({ capabilities: { delegation: { maxDepth: 2 } } }),
    path: "/capabilities/delegation",
    severity: "warning",
  },
  "instructions.empty": { spec: spec({ instructions: [] }), path: "/instructions", severity: "warning" },
  "models.unmatched": {
    spec: spec({ instructions: [{ text: "x", models: "openai/*" }] }),
    path: "/instructions/0/models",
    severity: "warning",
  },
  "provider.profile.required": {
    spec: spec({ model: { id: "anthropic/claude-sonnet-5" } }),
    path: "/model",
    severity: "error",
    ctx: { config: {}, agents: [] },
  },
  "provider.profile.unknown": {
    spec: spec({ model: { id: "anthropic/claude-sonnet-5", providerProfile: "nope" } }),
    path: "/model/providerProfile",
    severity: "error",
  },
  "provider.model.unsupported": {
    spec: spec({ model: { id: "anthropic/claude-sonnet-5", fallbacks: ["openai/gpt-5"] } }),
    path: "/model/fallbacks/0",
    severity: "error",
  },
  "capability.unavailable": {
    spec: spec({ capabilities: { scheduling: { maxPending: 1 } } }),
    path: "/capabilities/scheduling",
    severity: "error",
  },
  "capability.over-ceiling": {
    spec: spec({ capabilities: { longRunning: { maxSteps: 500 } } }),
    path: "/capabilities/longRunning/maxSteps",
    severity: "error",
  },
  "approvals.over-ceiling": {
    spec: spec({ approvals: { timeout: 120_000 } }),
    path: "/approvals/timeout",
    severity: "error",
  },
  "ref.agent.unknown": {
    spec: spec({ delegates: ["nope"], capabilities: { delegation: {} } }),
    path: "/delegates/0",
    severity: "error",
  },
  "memory.profile.conflict": {
    spec: spec({ memory: { profile: { properties: { tier: { type: "string" } } } } }),
    path: "/memory/profile/properties/tier",
    severity: "error",
  },
};

describe("validateAgentSpec", () => {
  it.each(Object.entries(cases))("reports %s", (code, { spec, path, severity, ctx }) => {
    const result = validate(spec, ctx);
    expect(result.ok).toBe(severity === "warning");
    if (result.ok) {
      expect(result).not.toHaveProperty("issues");
      expect(result.warnings).toContainEqual(expect.objectContaining({ code, path, severity }));
      expect(result.normalized).toBeDefined();
    } else {
      expect(result).not.toHaveProperty("normalized");
      expect(result.issues).toContainEqual(expect.objectContaining({ code, path, severity }));
    }
  });

  it("has a case for every code", () => {
    expect(Object.keys(cases).sort()).toEqual([...ISSUE_CODES].sort());
  });

  it("accepts a full Spec and normalises references to objects", () => {
    const loose: ScopeContext = {
      config: { providers: { default: { adapter: "anthropic", models: ["anthropic/*", "openai/*"] } } },
      agents: [helper()],
    };
    const result = validate(
      spec({
        description: "Front desk",
        instructions: [
          { text: "Help." },
          { fragment: "greeting", args: { tone: "warm" }, models: ["anthropic/*"] },
          { text: "Fallback", models: "openai/gpt-5*" },
        ],
        model: {
          id: "anthropic/claude-sonnet-5",
          providerProfile: "default",
          fallbacks: ["openai/gpt-5"],
          params: { temperature: 0.2, reasoning: "low" },
        },
        tools: [
          "echo",
          { name: "weather", settings: { units: "c" }, alwaysLoad: true },
          "mcp:github",
          "mcp:linear/create_issue",
        ],
        skills: [{ name: "research", settings: { depth: 2 }, invokableBy: "user" }],
        knowledge: ["faq", { name: "policies", retriever: "fts", mode: "inline" }],
        delegates: ["helper"],
        connections: {
          weather_api: { type: "api_key", level: "agent", required: true },
          search_api: { type: "api_key", level: "user" },
          "mcp:github": { type: "oauth", level: "user" },
        },
        capabilities: {
          scripts: { tier: "isolate", limits: { cpuMs: 1000 }, tools: ["echo"] },
          longRunning: { maxSteps: 100 },
          delegation: { maxDepth: 2 },
          scheduling: { cron: true },
          providerTools: { tools: ["web_search"], limits: { maxCallsPerTurn: 5 } },
        },
        memory: {
          profile: {
            properties: {
              tier: { type: "string", enum: ["gold", "silver"] },
              tags: { type: "array", items: { type: "string" } },
            },
          },
          notes: true,
        },
        policy: [
          { match: { tool: "web_search" }, effect: "allow" },
          { match: { annotations: { readOnlyHint: true } }, effect: "allow" },
          { match: { tool: ["echo", "linear__*", "run_script", "remember"] }, effect: "ask" },
        ],
        hooks: { "after-tool": ["audit"] },
        context: { window: 200_000, toolOutput: { maxChars: 10_000 }, tools: { defer: "always" } },
        approvals: { timeout: 60_000 },
      }),
      loose,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected the Spec to validate.");
    expect(result).not.toHaveProperty("issues");
    expect(result.warnings).toEqual([]);
    expect(result.normalized.tools).toEqual([
      { name: "echo" },
      { name: "weather", settings: { units: "c" }, alwaysLoad: true },
      { name: "mcp:github" },
      { name: "mcp:linear/create_issue" },
    ]);
    expect(result.normalized.knowledge).toEqual([
      { name: "faq" },
      { name: "policies", retriever: "fts", mode: "inline" },
    ]);
    expect(result.normalized.context).toEqual({
      window: 200_000,
      toolOutput: { maxChars: 10_000 },
      tools: { defer: "always" },
    });
  });

  it("rejects a Spec that is not an object", () => {
    expect(diagnostics(validate(null))).toEqual([expect.objectContaining({ code: "shape.invalid-type", path: "" })]);
  });

  it("reports one issue per shape problem with its pointer", () => {
    const result = validate(
      spec({ model: { id: "no-slash", params: { temperature: 3 } }, capabilities: { longRunning: { maxSteps: 0 } } }),
    );
    expect(
      diagnostics(result)
        .map((i) => i.path)
        .sort(),
    ).toEqual(["/capabilities/longRunning/maxSteps", "/model/id", "/model/params/temperature"]);
  });

  it("checks required settings even when the reference is bare", () => {
    const result = validate(
      spec({ tools: ["weather"], connections: { weather_api: { type: "key", level: "agent" } } }),
    );
    expect(codesOf(diagnostics(result))).toEqual(["settings.invalid"]);
  });

  it("does not let an ask on a non-provider Tool trip the provider-tool rule", () => {
    const result = validate(
      spec({
        tools: ["echo"],
        capabilities: { providerTools: { tools: ["web_fetch"] } },
        policy: [
          { match: { tool: "*" }, effect: "deny" },
          { match: { tool: "echo" }, effect: "ask" },
        ],
      }),
    );
    expect(diagnostics(result)).toEqual([]);
  });

  it("lets Scripts call MCP Tools the Agent references", () => {
    const ok = spec({
      tools: ["mcp:linear/create_issue"],
      capabilities: { scripts: { tier: "isolate", tools: ["linear__create_issue"] } },
    });
    expect(diagnostics(validate(ok))).toEqual([]);
    const server = spec({
      tools: ["mcp:linear"],
      capabilities: { scripts: { tier: "isolate", tools: ["linear__create_issue", "echo"] } },
    });
    expect(diagnostics(validate(server))).toEqual([
      expect.objectContaining({ code: "capability.scripts.tool-unreferenced", path: "/capabilities/scripts/tools/1" }),
    ]);
  });

  it("skips the unreferenced-tool warning when a whole MCP server is referenced", () => {
    expect(
      diagnostics(
        validate(spec({ tools: ["mcp:github"], policy: [{ match: { tool: "github__create_issue" }, effect: "ask" }] })),
      ),
    ).toEqual([]);
  });

  it("restricts the Memory profile to renderable JSON Schema", () => {
    const result = validate(spec({ memory: { profile: { properties: { a: { $ref: "#/x" } } } as never } }));
    expect(diagnostics(result)).toEqual([
      expect.objectContaining({ code: "shape.unknown-key", path: "/memory/profile/properties/a" }),
    ]);
  });
});

describe("validateAgentSpec against a Scope", () => {
  it("skips the Scope layer when no Scope is given", () => {
    expect(diagnostics(validateAgentSpec(spec({ approvals: { timeout: 120_000 } }), catalogue))).toEqual([]);
  });

  it("uses the Scope's sole Provider profile when the Spec names none, and requires a name otherwise", () => {
    expect(
      diagnostics(validate(base, { config: { providers: { main: { adapter: "anthropic" } } }, agents: [] })),
    ).toEqual([]);
    expect(diagnostics(validate(base, { config: {}, agents: [] }))).toEqual([
      expect.objectContaining({ code: "provider.profile.required", path: "/model", context: { profiles: [] } }),
    ]);
    const two = { config: { providers: { a: { adapter: "anthropic" }, b: { adapter: "anthropic" } } }, agents: [] };
    expect(diagnostics(validate(base, two))).toEqual([
      expect.objectContaining({ code: "provider.profile.required", path: "/model", context: { profiles: ["a", "b"] } }),
    ]);
    const withDefault = {
      config: { providers: { default: { adapter: "anthropic" }, b: { adapter: "anthropic", models: ["openai/*"] } } },
      agents: [],
    };
    expect(diagnostics(validate(base, withDefault))).toEqual([]);
  });

  it("checks every model against the profile's fallback target too", () => {
    const ctx: ScopeContext = {
      config: {
        providers: {
          own: { adapter: "anthropic", credential: "scope:k", fallback: { profile: "shared" } },
          shared: { adapter: "anthropic", models: ["anthropic/claude-sonnet-5"], credential: "deployment:k" },
        },
      },
      agents: [],
      deploymentProviders: {
        shared: { adapter: "anthropic", models: ["anthropic/claude-opus-5"], credential: "deployment:k" },
      },
    };
    const model = { id: "anthropic/claude-sonnet-5", providerProfile: "own", fallbacks: ["anthropic/claude-opus-5"] };
    expect(diagnostics(validate(spec({ model }), ctx))).toEqual([
      expect.objectContaining({
        code: "provider.model.unsupported",
        path: "/model/id",
        context: expect.objectContaining({ profile: "shared" }),
      }),
    ]);
  });

  it("bounds tier, cron and Provider Tools by the ceiling", () => {
    const ctx: ScopeContext = {
      config: {
        providers: { default: { adapter: "anthropic" } },
        ceilings: {
          scripts: { tier: "isolate" },
          scheduling: { cron: false },
          providerTools: { tools: ["web_search"] },
        },
      },
      agents: [],
    };
    const result = validate(
      spec({
        capabilities: {
          scripts: { tier: "container" },
          scheduling: { cron: true },
          providerTools: { tools: ["web_search", "web_fetch"] },
        },
      }),
      ctx,
    );
    expect(
      diagnostics(result)
        .map((i) => i.path)
        .sort(),
    ).toEqual(["/capabilities/providerTools/tools/1", "/capabilities/scheduling/cron", "/capabilities/scripts/tier"]);
    expect(new Set(codesOf(diagnostics(result)))).toEqual(new Set(["capability.over-ceiling"]));
  });

  it("lets a Spec ask for exactly the ceiling", () => {
    expect(
      diagnostics(validate(spec({ capabilities: { longRunning: { maxSteps: 100 } }, approvals: { timeout: 60_000 } }))),
    ).toEqual([]);
  });

  it("leaves its own previous version out of the Memory profile union", () => {
    const ctx: ScopeContext = {
      config: scope.config,
      agents: [
        { agentId: "concierge", spec: { ...base, memory: { profile: { properties: { tier: { type: "number" } } } } } },
      ],
    };
    expect(
      diagnostics(validate(spec({ memory: { profile: { properties: { tier: { type: "string" } } } } }), ctx)),
    ).toEqual([]);
  });

  it("accepts a delegate stored in the Scope", () => {
    expect(diagnostics(validate(spec({ delegates: ["helper"], capabilities: { delegation: {} } })))).toEqual([]);
  });
});

describe("AgentSpecSchema", () => {
  it("accepts every AgentSpec at the type level", () => {
    // The reverse direction only differs by `| undefined` on optional keys (exactOptionalPropertyTypes).
    const toSchema = (s: AgentSpec): z.input<typeof AgentSpecSchema> => s;
    expect(toSchema(base)).toBe(base);
  });

  it("exports JSON Schema for Platform editors", () => {
    expect(agentSpecJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect((agentSpecJsonSchema.properties as Record<string, unknown>).agentId).toEqual({
      type: "string",
      pattern: "^[A-Za-z0-9_-]{1,64}$",
    });
    expect(agentSpecJsonSchema.required).toEqual(["agentId", "name", "instructions", "model"]);
    expect(JSON.parse(JSON.stringify(agentSpecJsonSchema))).toEqual(agentSpecJsonSchema);
  });

  it("keeps Framework defaults out of the Spec", () => {
    expect(AGENT_SPEC_DEFAULTS.approvals.timeout).toBe(86_400_000);
    expect(Object.isFrozen(AGENT_SPEC_DEFAULTS.context)).toBe(true);
  });
});

describe("boot verification", () => {
  it("defineAgent rejects a malformed Spec", () => {
    expect(() => defineAgent(spec({ model: { id: "no-slash" } }))).toThrowError(
      new KarmiError("agent.spec.invalid", 'Agent Spec "concierge" is invalid at "/model/id": must be provider/model'),
    );
  });

  it("assembleCatalogue rejects an Agent whose references do not resolve", () => {
    const dangling = defineAgent(spec({ tools: ["nope"] }));
    expect(() => assembleCatalogue({ tools: [echo], agents: [dangling] })).toThrowError(
      /Agent "concierge" does not resolve against the Catalogue: \/tools\/0\/name: Unknown Tool "nope"/,
    );
  });

  it("assembleCatalogue lets warnings through", () => {
    const quiet = defineAgent(spec({ instructions: [] }));
    expect(assembleCatalogue({ agents: [quiet] }).agents.has("concierge")).toBe(true);
  });
});
