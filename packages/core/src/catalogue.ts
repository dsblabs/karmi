import type { Deliverer } from "./deliverer.js";
import type { Agent } from "./agent.js";
import { KarmiError } from "./errors.js";
import type { Fragment } from "./fragment.js";
import type { Hook, HookPoint } from "./hook.js";
import type { CatalogueKind } from "./names.js";
import type { Retriever } from "./retriever.js";
import { toJsonSchema, type JsonSchema } from "./schema.js";
import type { Skill } from "./skill.js";
import type { Tool, ToolAnnotations } from "./tool.js";
import { validateAgentSpec } from "./validate.js";

/** Everything a developer defines in code; registration is only by listing here. */
export interface CatalogueInput {
  deliverers?: Deliverer[];
  tools?: Tool[];
  fragments?: Fragment[];
  skills?: Skill[];
  retrievers?: Retriever[];
  hooks?: Hook[];
  agents?: Agent[];
}

export interface Catalogue {
  readonly deliverers: ReadonlyMap<string, Deliverer>;
  readonly tools: ReadonlyMap<string, Tool>;
  readonly fragments: ReadonlyMap<string, Fragment>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly retrievers: ReadonlyMap<string, Retriever>;
  readonly hooks: ReadonlyMap<string, Hook>;
  readonly agents: ReadonlyMap<string, Agent>;
  /** The Catalogue as data, so a Platform can build its editors from it. */
  describe(): CatalogueDescription;
  /** Digest of `describe()`, stored with each Agent Spec version so a changed Catalogue flags it for revalidation. */
  fingerprint(): Promise<string>;
}

export interface CatalogueDescription {
  deliverers: { name: string; granularity: NonNullable<Deliverer["granularity"]> }[];
  tools: ToolDescription[];
  fragments: FragmentDescription[];
  skills: SkillDescription[];
  retrievers: RetrieverDescription[];
  hooks: HookDescription[];
  agents: AgentDescription[];
}

export interface ToolDescription {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  input: JsonSchema;
  settings?: JsonSchema;
  requires?: string;
  instructions?: string;
}
export interface FragmentDescription {
  name: string;
  description?: string;
  args?: JsonSchema;
}
export interface SkillDescription {
  name: string;
  description: string;
  tools: string[];
  settings?: JsonSchema;
}
export interface RetrieverDescription {
  name: string;
  description?: string;
  settings?: JsonSchema;
}
export interface HookDescription {
  name: string;
  point: HookPoint;
  description?: string;
}
export interface AgentDescription {
  agentId: string;
  name: string;
  description?: string;
}

function byName<T extends { name: string }>(kind: CatalogueKind, items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.name)) throw new KarmiError("name.duplicate", `Duplicate ${kind} name "${item.name}" in the Catalogue.`);
    map.set(item.name, item);
  }
  return map;
}

// A Skill's Tools live only while the Skill is active, but the model sees one flat Tool namespace.
function assertOneToolNamespace(tools: ReadonlyMap<string, Tool>, skills: ReadonlyMap<string, Skill>): void {
  byName("tool", [...tools.values(), ...[...skills.values()].flatMap((s) => s.tools)]);
}

export function assembleCatalogue(input: CatalogueInput): Catalogue {
  const skills = byName("skill", input.skills ?? []);
  const tools = byName("tool", input.tools ?? []);
  assertOneToolNamespace(tools, skills);
  const fragments = byName("fragment", input.fragments ?? []);
  const retrievers = byName("retriever", input.retrievers ?? []);
  const hooks = byName("hook", input.hooks ?? []);
  const agents = new Map<string, Agent>();
  for (const agent of input.agents ?? []) {
    if (agents.has(agent.agentId)) throw new KarmiError("name.duplicate", `Duplicate agent "${agent.agentId}" in the Catalogue.`);
    agents.set(agent.agentId, agent);
  }
  let fingerprint: Promise<string> | undefined;
  const catalogue: Catalogue = {
    deliverers: byName("deliverer", input.deliverers ?? []),
    tools,
    fragments,
    skills,
    retrievers,
    hooks,
    agents,
    describe: () => describe(catalogue),
    fingerprint: () => (fingerprint ??= digest(JSON.stringify(catalogue.describe()))),
  };
  assertAgentsResolve(catalogue);
  return catalogue;
}

// A code-defined Agent that references a missing Catalogue item is a boot error, like any other dangling name.
function assertAgentsResolve(catalogue: Catalogue): void {
  for (const agent of catalogue.agents.values()) {
    const errors = validateAgentSpec(agent.spec, catalogue).issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      const detail = errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      throw new KarmiError("agent.spec.invalid", `Agent "${agent.agentId}" does not resolve against the Catalogue: ${detail}`);
    }
  }
}

// Optional keys are omitted rather than set to undefined so the output is stable JSON.
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function describe(c: Omit<Catalogue, "describe">): CatalogueDescription {
  return {
    deliverers: [...c.deliverers.values()].map(d => ({ name: d.name, granularity: d.granularity ?? "part" })),
    tools: [...c.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations,
      input: toJsonSchema(t.input),
      ...optional("settings", t.settings && toJsonSchema(t.settings)),
      ...optional("requires", t.requires),
      ...optional("instructions", t.instructions?.name),
    })),
    fragments: [...c.fragments.values()].map((f) => ({
      name: f.name,
      ...optional("description", f.description),
      ...optional("args", f.args && toJsonSchema(f.args)),
    })),
    skills: [...c.skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
      tools: s.tools.map((t) => t.name),
      ...optional("settings", s.settings && toJsonSchema(s.settings)),
    })),
    retrievers: [...c.retrievers.values()].map((r) => ({
      name: r.name,
      ...optional("description", r.description),
      ...optional("settings", r.settings && toJsonSchema(r.settings)),
    })),
    hooks: [...c.hooks.values()].map((h) => ({ name: h.name, point: h.point, ...optional("description", h.description) })),
    agents: [...c.agents.values()].map((a) => ({ agentId: a.agentId, name: a.spec.name, ...optional("description", a.spec.description) })),
  };
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
