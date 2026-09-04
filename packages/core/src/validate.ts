import * as z from "zod/mini";
import { AgentSpecSchema, type NormalizedAgentSpec } from "./agent-spec.js";
import type { Catalogue } from "./catalogue.js";
import { matchGlob } from "./glob.js";
import { BUILT_IN_TOOL_NAMES, IDENTIFIER } from "./names.js";
import type { Schema } from "./schema.js";
import type { Tool } from "./tool.js";

// Shape and reference layers of Agent Spec validation; the Scope-resolved layer arrives with the ScopeConfig DO.

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
  "policy.unreferenced-tool",
  "delegation.no-capability",
  "delegation.no-delegates",
  "instructions.empty",
  "models.unmatched",
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

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  /** Present when there are no errors; warnings never block. */
  normalized?: NormalizedAgentSpec;
}

interface McpReference {
  server: string;
  tool?: string;
}

function parseMcpReference(name: string): McpReference | undefined {
  const [server, tool, ...rest] = name.slice("mcp:".length).split("/");
  if (rest.length > 0 || !IDENTIFIER.test(server!) || (tool !== undefined && !IDENTIFIER.test(tool))) return undefined;
  return tool === undefined ? { server: server! } : { server: server!, tool };
}

function toList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function pointer(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment)}`).join("");
}

function shapeIssue(issue: z.core.$ZodIssue): Issue {
  const path = pointer(issue.path);
  if (issue.code === "unrecognized_keys") {
    if (path === "/capabilities" && issue.keys.includes("egress")) {
      return { severity: "error", code: "capability.reserved", path: `${path}/egress`, message: "The `egress` Capability is reserved for the container tier." };
    }
    return { severity: "error", code: "shape.unknown-key", path, message: issue.message, context: { keys: issue.keys } };
  }
  if (issue.code === "invalid_type") {
    return { severity: "error", code: "shape.invalid-type", path, message: issue.message, context: { expected: issue.expected } };
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

/** Validates a Spec against the Catalogue alone; needs no Scope, so a Platform can run it anywhere. */
export function validateAgentSpec(spec: unknown, catalogue: Catalogue): ValidationResult {
  const parsed = z.safeParse(AgentSpecSchema, spec);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(shapeIssue) };
  }
  const issues = new Issues();
  new ReferenceChecker(parsed.data, catalogue, issues).run();
  const ok = issues.list.every((issue) => issue.severity !== "error");
  return { ok, issues: issues.list, ...(ok && { normalized: parsed.data }) };
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
    if (instructions.length === 0) this.issues.warn("instructions.empty", "/instructions", "The Agent has no instructions.");
    const models = [model.id, ...(model.fallbacks ?? [])];
    instructions.forEach((entry, i) => {
      const path = `/instructions/${i}`;
      if (entry.models !== undefined) {
        if (!toList(entry.models).some((glob) => models.some((id) => matchGlob(glob, id)))) {
          this.issues.warn("models.unmatched", `${path}/models`, `No model in this Spec matches ${JSON.stringify(entry.models)}; the entry never applies.`, { models });
        }
      }
      if (!("fragment" in entry)) return;
      const fragment = this.catalogue.fragments.get(entry.fragment);
      if (!fragment) {
        this.issues.error("ref.fragment.unknown", `${path}/fragment`, `Unknown Fragment "${entry.fragment}".`, { name: entry.fragment });
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
          this.issues.error("ref.mcp.invalid", `${path}/name`, `"${ref.name}" must be mcp:<server> or mcp:<server>/<tool>.`, { name: ref.name });
          return;
        }
        this.mcpRefs.push(mcp);
        if (ref.settings !== undefined) this.issues.error("settings.unexpected", `${path}/settings`, `MCP Tools take no settings.`);
        return;
      }
      if (BUILT_IN_TOOL_NAMES.includes(ref.name)) {
        this.issues.error("ref.tool.built-in", `${path}/name`, `"${ref.name}" is a built-in Tool; it is granted by a Capability, not referenced.`, { name: ref.name });
        return;
      }
      const tool = this.catalogue.tools.get(ref.name);
      if (!tool) {
        this.issues.error("ref.tool.unknown", `${path}/name`, `Unknown Tool "${ref.name}".`, { name: ref.name });
        return;
      }
      this.reachableTools.set(tool.name, tool);
      this.validateAgainstItemSchema("settings", tool.settings, ref.settings, `${path}/settings`, `Tool "${tool.name}"`);
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
      this.validateAgainstItemSchema("settings", skill.settings, ref.settings, `${path}/settings`, `Skill "${skill.name}"`);
    });
  }

  private knowledge(): void {
    const seen = new Set<string>();
    (this.spec.knowledge ?? []).forEach((ref, i) => {
      const path = `/knowledge/${i}`;
      if (this.rejectDuplicate(seen, ref.name, path)) return;
      if (ref.retriever !== undefined && !this.catalogue.retrievers.has(ref.retriever)) {
        this.issues.error("ref.retriever.unknown", `${path}/retriever`, `Unknown Retriever "${ref.retriever}".`, { name: ref.retriever });
      }
    });
  }

  private delegates(): void {
    const delegates = this.spec.delegates ?? [];
    const seen = new Set<string>();
    delegates.forEach((agentId, i) => this.rejectDuplicate(seen, agentId, `/delegates/${i}`));
    const granted = this.spec.capabilities?.delegation !== undefined;
    if (delegates.length > 0 && !granted) {
      this.issues.error("delegation.no-capability", "/delegates", "Delegates are listed but the `delegation` Capability is not granted.");
    }
    if (delegates.length === 0 && granted) {
      this.issues.warn("delegation.no-delegates", "/capabilities/delegation", "The `delegation` Capability is granted but no delegates are listed.");
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
          this.issues.error("ref.hook.point", path, `Hook "${hookName}" runs at "${hook.point}", not "${point}".`, { name: hookName, point: hook.point });
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
        this.issues.error("connection.missing", `/connections/${tool.requires}`, `Tool "${tool.name}" requires the Connection "${tool.requires}", which the Spec does not declare.`, {
          tool: tool.name,
          connection: tool.requires,
        });
      }
    }
    // An OAuth grant for an MCP server is the Connection `mcp:<server>`; the ref implies it.
    for (const { server } of this.mcpRefs) required.add(`mcp:${server}`);
    for (const connection of Object.keys(declared)) {
      if (!required.has(connection)) this.issues.warn("connection.unused", `/connections/${connection}`, `No referenced Tool requires the Connection "${connection}".`, { connection });
    }
  }

  private scripts(): void {
    const tools = this.spec.capabilities?.scripts?.tools;
    if (!Array.isArray(tools)) return;
    tools.forEach((toolName, i) => {
      if (!this.reachableTools.has(toolName)) {
        this.issues.error("capability.scripts.tool-unreferenced", `/capabilities/scripts/tools/${i}`, `Scripts may only call Tools the Agent references; "${toolName}" is not one of them.`, { name: toolName });
      }
    });
  }

  private policy(): void {
    const rules = this.spec.policy ?? [];
    const providerTools = this.spec.capabilities?.providerTools?.tools ?? [];
    const capabilities = this.spec.capabilities ?? {};
    const granted = new Set<string>([...this.reachableTools.keys(), ...providerTools, "read_output", "tool_search"]);
    if (this.spec.memory !== undefined) for (const name of ["remember", "recall"]) granted.add(name);
    if (capabilities.scripts) granted.add("run_script");
    if (capabilities.delegation) granted.add("delegate");
    if (capabilities.scheduling) for (const name of ["schedule", "cancel_schedule", "list_schedules"]) granted.add(name);
    for (const { server, tool } of this.mcpRefs) if (tool !== undefined) granted.add(`${server}__${tool}`);
    // A whole-server ref brings Tools only the Scope's registry knows, so literal names cannot be checked.
    const wholeServers = this.mcpRefs.some((ref) => ref.tool === undefined);

    rules.forEach((rule, i) => {
      const path = `/policy/${i}`;
      if (rule.match.tool === undefined && rule.match.annotations === undefined) {
        this.issues.error("policy.match.empty", `${path}/match`, "A Policy rule must match on `tool`, `annotations` or both.");
        return;
      }
      if (rule.match.tool === undefined) return;
      toList(rule.match.tool).forEach((glob, j) => {
        const globPath = Array.isArray(rule.match.tool) ? `${path}/match/tool/${j}` : `${path}/match/tool`;
        if (!glob.includes("*") && !wholeServers && !granted.has(glob)) {
          this.issues.warn("policy.unreferenced-tool", globPath, `No Tool of this Agent is named "${glob}"; the rule never matches.`, { tool: glob });
        }
      });
    });

    // Provider Tools run inside the provider's turn, so there is no call to pause on: `ask` cannot be honoured.
    for (const providerTool of providerTools) {
      const index = rules.findIndex((rule) => {
        return rule.match.annotations === undefined && toList(rule.match.tool ?? []).some((glob) => matchGlob(glob, providerTool));
      });
      if (index !== -1 && rules[index]!.effect === "ask") {
        this.issues.error("policy.ask-on-provider-tool", `/policy/${index}/effect`, `Provider Tool "${providerTool}" can only be allowed or denied, never asked.`, { tool: providerTool });
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
  private validateAgainstItemSchema(kind: "settings" | "args", schema: Schema | undefined, value: unknown, path: string, owner: string): void {
    if (schema === undefined) {
      if (value !== undefined) this.issues.error(`${kind}.unexpected`, path, `${owner} takes no ${kind}.`);
      return;
    }
    const result = z.safeParse(schema, value ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        const message = value === undefined ? `${owner} requires ${kind}: ${issue.message}` : `${owner}: ${issue.message}`;
        this.issues.error(`${kind}.invalid`, `${path}${pointer(issue.path)}`, message, { zod: issue.code });
      }
    }
  }
}
