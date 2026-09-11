import * as z from "zod/mini";
import { AGENT_SPEC_DEFAULTS, AgentSpecSchema, type NormalizedAgentSpec } from "./agent-spec";
import type { AgentSpec, Capabilities, MemoryProfileProperty } from "./agent";
import type { Catalogue } from "./catalogue";
import { matchGlob } from "./glob";
import { BUILT_IN_TOOL_NAMES, IDENTIFIER } from "./names";
import type { Ceilings, ScopeConfigDocument } from "./scope-config";
import type { Schema } from "./schema";
import type { Tool } from "./tool";

// The three layers of Agent Spec validation: shape (zod), references (Catalogue), Scope-resolved (ceilings,
// Provider profiles, the other Agents in the Scope). MCP registry and Connection-value checks join the
// Scope layer with the MCP tickets.

export const ISSUE_CODES = [
  "shape.invalid-type",
  "shape.unknown-key",
  "shape.invalid",
  "capability.reserved",
  "capability.scripts.tool-unreferenced",
  "ref.tool.unknown",
  "ref.tool.built-in",
  "ref.mcp.invalid",
  "ref.skill.unknown",
  "ref.retriever.unknown",
  "ref.fragment.unknown",
  "ref.hook.unknown",
  "ref.hook.point",
  "ref.duplicate",
  "settings.invalid",
  "settings.unexpected",
  "args.invalid",
  "args.unexpected",
  "connection.missing",
  "connection.unused",
  "policy.match.empty",
  "policy.ask-on-provider-tool",
  "policy.tool-search-denied",
  "policy.unreferenced-tool",
  "delegation.no-capability",
  "delegation.no-delegates",
  "instructions.empty",
  "models.unmatched",
  "provider.profile.required",
  "provider.profile.unknown",
  "provider.model.unsupported",
  "capability.unavailable",
  "capability.over-ceiling",
  "approvals.over-ceiling",
  "ref.agent.unknown",
  "memory.profile.conflict",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  severity: "error" | "warning";
  code: IssueCode;
  /** JSON-pointer into the Spec, `""` for the whole document. */
  path: string;
  message: string;
  context?: Record<string, unknown>;
}

type ErrorIssue = Issue & { severity: "error" };
type WarningIssue = Issue & { severity: "warning" };

export type ValidationFailure = { ok: false; issues: [ErrorIssue, ...Issue[]] };

export type ValidationResult =
  { ok: true; normalized: NormalizedAgentSpec; warnings: WarningIssue[] } | ValidationFailure;

/** What the Scope layer sees: the resolved (Deployment ≤ Scope) config and the Scope's other Agents. */
export interface ScopeContext {
  config: ScopeConfigDocument;
  agents: readonly { agentId: string; spec: AgentSpec }[];
}

interface McpReference {
  server: string;
  tool?: string;
}

function parseMcpReference(name: string): McpReference | undefined {
  const [server = "", tool, ...rest] = name.slice("mcp:".length).split("/");
  if (rest.length > 0 || !IDENTIFIER.test(server) || (tool !== undefined && !IDENTIFIER.test(tool))) return undefined;
  return tool === undefined ? { server } : { server, tool };
}

function toList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** The first issue of a failed parse; zod never fails without one. */
export function firstIssue(error: z.core.$ZodError): z.core.$ZodIssue {
  const [issue] = error.issues;
  if (!issue) throw new Error("A failed zod parse reported no issue.");
  return issue;
}

export function pointer(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment)}`).join("");
}

function shapeIssue(issue: z.core.$ZodIssue): ErrorIssue {
  const path = pointer(issue.path);
  if (issue.code === "unrecognized_keys") {
    if (path === "/capabilities" && issue.keys.includes("egress")) {
      return {
        severity: "error",
        code: "capability.reserved",
        path: `${path}/egress`,
        message: "The `egress` Capability is reserved for the container tier.",
      };
    }
    return {
      severity: "error",
      code: "shape.unknown-key",
      path,
      message: issue.message,
      context: { keys: issue.keys },
    };
  }
  if (issue.code === "invalid_type") {
    return {
      severity: "error",
      code: "shape.invalid-type",
      path,
      message: issue.message,
      context: { expected: issue.expected },
    };
  }
  return { severity: "error", code: "shape.invalid", path, message: issue.message };
}

class Issues {
  readonly list: Issue[] = [];
  error(code: IssueCode, path: string, message: string, context?: Record<string, unknown>): void {
    this.list.push({ severity: "error", code, path, message, ...(context && { context }) });
  }
  warn(code: IssueCode, path: string, message: string, context?: Record<string, unknown>): void {
    this.list.push({ severity: "warning", code, path, message, ...(context && { context }) });
  }
}

/** Without a Scope only the shape and reference layers run, so a Platform can check a Spec anywhere. */
export function validateAgentSpec(spec: unknown, catalogue: Catalogue, scope?: ScopeContext): ValidationResult {
  const parsed = z.safeParse(AgentSpecSchema, spec);
  if (!parsed.success) {
    const first = firstIssue(parsed.error);
    return { ok: false, issues: [shapeIssue(first), ...parsed.error.issues.slice(1).map(shapeIssue)] };
  }
  const issues = new Issues();
  new ReferenceChecker(parsed.data, catalogue, issues).run();
  if (scope) new ScopeChecker(parsed.data, catalogue, scope, issues).run();
  const error = issues.list.find((issue): issue is ErrorIssue => issue.severity === "error");
  if (error) return { ok: false, issues: [error, ...issues.list.filter((issue) => issue !== error)] };
  return {
    ok: true,
    normalized: parsed.data,
    warnings: issues.list.map((issue) => ({ ...issue, severity: "warning" })),
  };
}

class ReferenceChecker {
  /** Catalogue Tools this Agent can reach, directly or through a Skill. */
  private readonly reachableTools = new Map<string, Tool>();
  private readonly mcpRefs: McpReference[] = [];

  constructor(
    private readonly spec: NormalizedAgentSpec,
    private readonly catalogue: Catalogue,
    private readonly issues: Issues,
  ) {}

  run(): void {
    this.instructions();
    this.tools();
    this.skills();
    this.knowledge();
    this.delegates();
    this.hooks();
    this.connections();
    this.scripts();
    this.policy();
  }

  private instructions(): void {
    const { instructions, model } = this.spec;
    if (instructions.length === 0)
      this.issues.warn("instructions.empty", "/instructions", "The Agent has no instructions.");
    const models = [model.id, ...(model.fallbacks ?? [])];
    instructions.forEach((entry, i) => {
      const path = `/instructions/${i}`;
      if (entry.models !== undefined) {
        if (!toList(entry.models).some((glob) => models.some((id) => matchGlob(glob, id)))) {
          this.issues.warn(
            "models.unmatched",
            `${path}/models`,
            `No model in this Spec matches ${JSON.stringify(entry.models)}; the entry never applies.`,
            { models },
          );
        }
      }
      if (!("fragment" in entry)) return;
      const fragment = this.catalogue.fragments.get(entry.fragment);
      if (!fragment) {
        this.issues.error("ref.fragment.unknown", `${path}/fragment`, `Unknown Fragment "${entry.fragment}".`, {
          name: entry.fragment,
        });
        return;
      }
      this.validateAgainstItemSchema("args", fragment.args, entry.args, `${path}/args`, `Fragment "${fragment.name}"`);
    });
  }

  private tools(): void {
    const seen = new Set<string>();
    (this.spec.tools ?? []).forEach((ref, i) => {
      const path = `/tools/${i}`;
      if (this.rejectDuplicate(seen, ref.name, path)) return;
      if (ref.name.startsWith("mcp:")) {
        const mcp = parseMcpReference(ref.name);
        if (!mcp) {
          this.issues.error(
            "ref.mcp.invalid",
            `${path}/name`,
            `"${ref.name}" must be mcp:<server> or mcp:<server>/<tool>.`,
            { name: ref.name },
          );
          return;
        }
        this.mcpRefs.push(mcp);
        if (ref.settings !== undefined)
          this.issues.error("settings.unexpected", `${path}/settings`, `MCP Tools take no settings.`);
        return;
      }
      if (BUILT_IN_TOOL_NAMES.includes(ref.name)) {
        this.issues.error(
          "ref.tool.built-in",
          `${path}/name`,
          `"${ref.name}" is a built-in Tool; it is granted by a Capability, not referenced.`,
          { name: ref.name },
        );
        return;
      }
      const tool = this.catalogue.tools.get(ref.name);
      if (!tool) {
        this.issues.error("ref.tool.unknown", `${path}/name`, `Unknown Tool "${ref.name}".`, { name: ref.name });
        return;
      }
      this.reachableTools.set(tool.name, tool);
      this.validateAgainstItemSchema(
        "settings",
        tool.settings,
        ref.settings,
        `${path}/settings`,
        `Tool "${tool.name}"`,
      );
    });
  }

  private skills(): void {
    const seen = new Set<string>();
    (this.spec.skills ?? []).forEach((ref, i) => {
      const path = `/skills/${i}`;
      if (this.rejectDuplicate(seen, ref.name, path)) return;
      const skill = this.catalogue.skills.get(ref.name);
      if (!skill) {
        this.issues.error("ref.skill.unknown", `${path}/name`, `Unknown Skill "${ref.name}".`, { name: ref.name });
        return;
      }
      for (const tool of skill.tools) this.reachableTools.set(tool.name, tool);
      this.validateAgainstItemSchema(
        "settings",
        skill.settings,
        ref.settings,
        `${path}/settings`,
        `Skill "${skill.name}"`,
      );
    });
  }

  private knowledge(): void {
    const seen = new Set<string>();
    (this.spec.knowledge ?? []).forEach((ref, i) => {
      const path = `/knowledge/${i}`;
      if (this.rejectDuplicate(seen, ref.name, path)) return;
      if (ref.retriever !== undefined && !this.catalogue.retrievers.has(ref.retriever)) {
        this.issues.error("ref.retriever.unknown", `${path}/retriever`, `Unknown Retriever "${ref.retriever}".`, {
          name: ref.retriever,
        });
      }
    });
  }

  private delegates(): void {
    const delegates = this.spec.delegates ?? [];
    const seen = new Set<string>();
    delegates.forEach((agentId, i) => this.rejectDuplicate(seen, agentId, `/delegates/${i}`));
    const granted = this.spec.capabilities?.delegation !== undefined;
    if (delegates.length > 0 && !granted) {
      this.issues.error(
        "delegation.no-capability",
        "/delegates",
        "Delegates are listed but the `delegation` Capability is not granted.",
      );
    }
    if (delegates.length === 0 && granted) {
      this.issues.warn(
        "delegation.no-delegates",
        "/capabilities/delegation",
        "The `delegation` Capability is granted but no delegates are listed.",
      );
    }
  }

  private hooks(): void {
    for (const [point, names] of Object.entries(this.spec.hooks ?? {})) {
      names.forEach((hookName, i) => {
        const path = `/hooks/${point}/${i}`;
        const hook = this.catalogue.hooks.get(hookName);
        if (!hook) {
          this.issues.error("ref.hook.unknown", path, `Unknown Hook "${hookName}".`, { name: hookName });
        } else if (hook.point !== point) {
          this.issues.error("ref.hook.point", path, `Hook "${hookName}" runs at "${hook.point}", not "${point}".`, {
            name: hookName,
            point: hook.point,
          });
        }
      });
    }
  }

  private connections(): void {
    const declared = this.spec.connections ?? {};
    const required = new Set<string>();
    for (const tool of this.reachableTools.values()) {
      if (tool.requires === undefined) continue;
      required.add(tool.requires);
      if (!(tool.requires in declared)) {
        this.issues.error(
          "connection.missing",
          `/connections/${tool.requires}`,
          `Tool "${tool.name}" requires the Connection "${tool.requires}", which the Spec does not declare.`,
          {
            tool: tool.name,
            connection: tool.requires,
          },
        );
      }
    }
    // An OAuth grant for an MCP server is the Connection `mcp:<server>`; the ref implies it.
    for (const { server } of this.mcpRefs) required.add(`mcp:${server}`);
    for (const connection of Object.keys(declared)) {
      if (!required.has(connection))
        this.issues.warn(
          "connection.unused",
          `/connections/${connection}`,
          `No referenced Tool requires the Connection "${connection}".`,
          { connection },
        );
    }
  }

  /** Every Tool name the model may see, as far as the Catalogue can tell; whole-server MCP refs add more at Turn start. */
  private grantedToolNames(): Set<string> {
    const capabilities = this.spec.capabilities ?? {};
    const granted = new Set<string>([
      ...this.reachableTools.keys(),
      ...(capabilities.providerTools?.tools ?? []),
      "read_output",
      "tool_search",
    ]);
    if (this.spec.memory !== undefined) for (const name of ["remember", "recall"]) granted.add(name);
    if ((this.spec.skills ?? []).length > 0) granted.add("use_skill");
    if (capabilities.scripts) granted.add("run_script");
    if (capabilities.delegation) granted.add("delegate");
    if (capabilities.scheduling)
      for (const name of ["schedule", "cancel_schedule", "list_schedules"]) granted.add(name);
    for (const { server, tool } of this.mcpRefs) if (tool !== undefined) granted.add(`${server}__${tool}`);
    return granted;
  }

  private scripts(): void {
    const tools = this.spec.capabilities?.scripts?.tools;
    if (!Array.isArray(tools)) return;
    const granted = this.grantedToolNames();
    const wholeServers = this.mcpRefs.some((ref) => ref.tool === undefined);
    tools.forEach((toolName, i) => {
      if (!granted.has(toolName) && !(wholeServers && toolName.includes("__"))) {
        this.issues.error(
          "capability.scripts.tool-unreferenced",
          `/capabilities/scripts/tools/${i}`,
          `Scripts may only call Tools the Agent references; "${toolName}" is not one of them.`,
          { name: toolName },
        );
      }
    });
  }

  private policy(): void {
    const rules = this.spec.policy ?? [];
    const providerTools = this.spec.capabilities?.providerTools?.tools ?? [];
    const granted = this.grantedToolNames();
    // A whole-server ref brings Tools only the Scope's registry knows, so literal names cannot be checked.
    const wholeServers = this.mcpRefs.some((ref) => ref.tool === undefined);

    // With deferral on, `tool_search` is the only way to a deferred Tool; a rule that names it to deny it contradicts the Spec.
    const defer = this.spec.context?.tools?.defer ?? AGENT_SPEC_DEFAULTS.context.tools.defer;
    rules.forEach((rule, i) => {
      const path = `/policy/${i}`;
      if (defer !== "never" && rule.effect === "deny" && toList(rule.match.tool ?? []).includes("tool_search")) {
        this.issues.error(
          "policy.tool-search-denied",
          `${path}/effect`,
          '`tool_search` cannot be denied while `context.tools.defer` is not "never": it is how deferred Tools are loaded.',
        );
      }
      if (rule.match.tool === undefined && rule.match.annotations === undefined) {
        this.issues.error(
          "policy.match.empty",
          `${path}/match`,
          "A Policy rule must match on `tool`, `annotations` or both.",
        );
        return;
      }
      if (rule.match.tool === undefined) return;
      toList(rule.match.tool).forEach((glob, j) => {
        const globPath = Array.isArray(rule.match.tool) ? `${path}/match/tool/${j}` : `${path}/match/tool`;
        if (!glob.includes("*") && !wholeServers && !granted.has(glob)) {
          this.issues.warn(
            "policy.unreferenced-tool",
            globPath,
            `No Tool of this Agent is named "${glob}"; the rule never matches.`,
            { tool: glob },
          );
        }
      });
    });

    // Provider Tools run inside the provider's turn, so there is no call to pause on: `ask` cannot be honoured.
    // Only an explicit `ask` is an error; a Provider Tool no rule names is included, since the grant itself is the consent.
    for (const providerTool of providerTools) {
      const index = rules.findIndex((rule) => {
        return (
          rule.match.annotations === undefined &&
          toList(rule.match.tool ?? []).some((glob) => matchGlob(glob, providerTool))
        );
      });
      if (rules[index]?.effect === "ask") {
        this.issues.error(
          "policy.ask-on-provider-tool",
          `/policy/${index}/effect`,
          `Provider Tool "${providerTool}" can only be allowed or denied, never asked.`,
          { tool: providerTool },
        );
      }
    }
  }

  /** Reports a repeated reference; returns true when the caller should skip it. */
  private rejectDuplicate(seen: Set<string>, name: string, path: string): boolean {
    if (seen.has(name)) {
      this.issues.error("ref.duplicate", path, `"${name}" is referenced more than once.`, { name });
      return true;
    }
    seen.add(name);
    return false;
  }

  // A bare reference is validated as `{}` so a schema with required keys reports what is missing.
  private validateAgainstItemSchema(
    kind: "settings" | "args",
    schema: Schema | undefined,
    value: unknown,
    path: string,
    owner: string,
  ): void {
    if (schema === undefined) {
      if (value !== undefined) this.issues.error(`${kind}.unexpected`, path, `${owner} takes no ${kind}.`);
      return;
    }
    const result = z.safeParse(schema, value ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        const message =
          value === undefined ? `${owner} requires ${kind}: ${issue.message}` : `${owner}: ${issue.message}`;
        this.issues.error(`${kind}.invalid`, `${path}${pointer(issue.path)}`, message, { zod: issue.code });
      }
    }
  }
}

class ScopeChecker {
  constructor(
    private readonly spec: NormalizedAgentSpec,
    private readonly catalogue: Catalogue,
    private readonly scope: ScopeContext,
    private readonly issues: Issues,
  ) {}

  run(): void {
    this.provider();
    this.ceilings();
    this.delegates();
    this.memoryProfile();
  }

  private provider(): void {
    const { model } = this.spec;
    const providers = this.scope.config.providers ?? {};
    // A Spec may leave the choice open only when the Scope has just one profile; there is no magic name.
    const profileName =
      model.providerProfile ?? (Object.keys(providers).length === 1 ? Object.keys(providers)[0] : undefined);
    if (profileName === undefined) {
      const profiles = Object.keys(providers);
      const hint =
        profiles.length === 0
          ? "the Scope has no Provider profiles"
          : `one of ${profiles.map((p) => `"${p}"`).join(", ")}`;
      this.issues.error("provider.profile.required", "/model", `Set model.providerProfile: ${hint}.`, { profiles });
      return;
    }
    const profile = providers[profileName];
    if (!profile) {
      this.issues.error(
        "provider.profile.unknown",
        "/model/providerProfile",
        `Provider profile "${profileName}" is not configured for this Scope.`,
        { profile: profileName },
      );
      return;
    }
    const globs = profile.models ?? [`${profile.adapter}/*`];
    const check = (id: string, path: string) => {
      if (!globs.some((glob) => matchGlob(glob, id))) {
        this.issues.error(
          "provider.model.unsupported",
          path,
          `Provider profile "${profileName}" does not serve "${id}".`,
          { profile: profileName, model: id, models: globs },
        );
      }
    };
    check(model.id, "/model/id");
    (model.fallbacks ?? []).forEach((id, i) => check(id, `/model/fallbacks/${i}`));
  }

  private ceilings(): void {
    const ceilings = this.scope.config.ceilings ?? {};
    const capabilities = this.spec.capabilities ?? {};
    for (const key of Object.keys(capabilities) as (keyof Capabilities)[]) {
      const ceiling = ceilings[key];
      const path = `/capabilities/${key}`;
      if (ceiling === false) {
        this.issues.error("capability.unavailable", path, `The \`${key}\` Capability is not available in this Scope.`);
      } else if (ceiling !== undefined) {
        this.overCeiling(capabilities[key] as Record<string, unknown>, ceiling as Record<string, unknown>, path);
      }
    }
    const timeout = this.spec.approvals?.timeout;
    const maxTimeout = ceilings.approvals?.timeout;
    if (timeout !== undefined && maxTimeout !== undefined && timeout > maxTimeout) {
      this.issues.error(
        "approvals.over-ceiling",
        "/approvals/timeout",
        `Approval timeout ${timeout} exceeds the Scope ceiling ${maxTimeout}.`,
        { requested: timeout, ceiling: maxTimeout },
      );
    }
  }

  // Mirrors `tighten` in scope-config.ts: numbers are maxima, booleans and tiers are the most a Spec may ask, lists are allow-lists.
  private overCeiling(asked: Record<string, unknown>, ceiling: Record<string, unknown>, path: string): void {
    for (const [key, max] of Object.entries(ceiling)) {
      const value = asked[key];
      if (value === undefined || max === undefined) continue;
      const at = `${path}/${key}`;
      const over = (requested: unknown, limit: unknown) =>
        this.issues.error(
          "capability.over-ceiling",
          at,
          `Requested ${JSON.stringify(requested)} exceeds the Scope ceiling ${JSON.stringify(limit)}.`,
          { requested, ceiling: limit },
        );
      if (typeof max === "number") {
        if (typeof value === "number" && value > max) over(value, max);
      } else if (typeof max === "boolean") {
        if (value === true && !max) over(value, max);
      } else if (Array.isArray(max)) {
        (value as unknown[]).forEach((item, i) => {
          if (!max.includes(item))
            this.issues.error(
              "capability.over-ceiling",
              `${at}/${i}`,
              `${JSON.stringify(item)} is outside the Scope ceiling ${JSON.stringify(max)}.`,
              { requested: item, ceiling: max },
            );
        });
      } else if (key === "tier") {
        if (value === "container" && max === "isolate") over(value, max);
      } else {
        this.overCeiling(value as Record<string, unknown>, max as Record<string, unknown>, at);
      }
    }
  }

  private delegates(): void {
    (this.spec.delegates ?? []).forEach((agentId, i) => {
      if (this.catalogue.agents.has(agentId) || this.scope.agents.some((agent) => agent.agentId === agentId)) return;
      this.issues.error("ref.agent.unknown", `/delegates/${i}`, `No Agent "${agentId}" exists in this Scope.`, {
        agentId,
      });
    });
  }

  // Memory is shared by every Agent in the Scope, so the Profile is a union: one field, one type.
  private memoryProfile(): void {
    const properties = this.spec.memory?.profile?.properties;
    if (!properties) return;
    for (const other of this.scope.agents) {
      if (other.agentId === this.spec.agentId) continue;
      for (const [field, property] of Object.entries(other.spec.memory?.profile?.properties ?? {})) {
        const mine = (properties[field] as MemoryProfileProperty | undefined)?.type;
        const theirs = property.type;
        if (mine === undefined || theirs === undefined || sameType(mine, theirs)) continue;
        this.issues.error(
          "memory.profile.conflict",
          `/memory/profile/properties/${field}`,
          `Memory profile field "${field}" is ${JSON.stringify(theirs)} in Agent "${other.agentId}".`,
          {
            agentId: other.agentId,
            type: theirs,
          },
        );
      }
    }
  }
}

function sameType(a: unknown, b: unknown): boolean {
  const normalise = (type: unknown) => JSON.stringify(toList(type as string | string[]).sort());
  return normalise(a) === normalise(b);
}
