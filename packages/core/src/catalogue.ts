import type { Deliverer } from "./deliverer";
import type { Agent } from "./agent";
import { KarmiError } from "./errors";
import type { Fragment } from "./fragment";
import type { Hook, HookPoint } from "./hook";
import type { CatalogueKind } from "./names";
import type { Retriever } from "./retriever";
import { toJsonSchema, type JsonSchema } from "./schema";
import type { Skill } from "./skill";
import type { Tool, ToolAnnotations } from "./tool";
import { sha256Hex } from "./digest";
import { validateAgentSpec } from "./validate";

/** The items a developer defines in code. Listing an item here is the only way to register it. */
export interface CatalogueInput {
  deliverers?: Deliverer[];
  tools?: Tool[];
  fragments?: Fragment[];
  skills?: Skill[];
  retrievers?: Retriever[];
  hooks?: Hook[];
  agents?: Agent[];
}

/** The assembled Catalogue. It holds every item by name and can describe itself as data. */
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
  /**
   * A digest of `describe()`. It is stored with each Agent Spec version so a changed Catalogue flags the
   * Spec for revalidation.
   */
  fingerprint(): Promise<string>;
}

/** The Catalogue as plain data, one list per kind. */
export interface CatalogueDescription {
  deliverers: { name: string; granularity: NonNullable<Deliverer["granularity"]> }[];
  tools: ToolDescription[];
  fragments: FragmentDescription[];
  skills: SkillDescription[];
  retrievers: RetrieverDescription[];
  hooks: HookDescription[];
  agents: AgentDescription[];
}

/** A Tool as data: its name, description, annotations and schemas. */
export interface ToolDescription {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  input: JsonSchema;
  settings?: JsonSchema;
  requires?: string;
  instructions?: string;
}
/** A Fragment as data. */
export interface FragmentDescription {
  name: string;
  description?: string;
  args?: JsonSchema;
}
/** A Skill as data, with the names of its Tools. */
export interface SkillDescription {
  name: string;
  description: string;
  tools: string[];
  invokableBy: Skill["invokableBy"];
  settings?: JsonSchema;
}
/** A Retriever as data. */
export interface RetrieverDescription {
  name: string;
  description?: string;
  settings?: JsonSchema;
}
/** A Hook as data, with the lifecycle point it runs at. */
export interface HookDescription {
  name: string;
  point: HookPoint;
  description?: string;
}
/** A code-defined Agent as data. */
export interface AgentDescription {
  agentId: string;
  name: string;
  description?: string;
}

function byName<T extends { name: string }>(kind: CatalogueKind, items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.name))
      throw new KarmiError("name.duplicate", `Duplicate ${kind} name "${item.name}" in the Catalogue.`);
    map.set(item.name, item);
  }
  return map;
}

// A Skill's Tools live only while the Skill is active, but the model sees one flat Tool namespace.
function assertOneToolNamespace(tools: ReadonlyMap<string, Tool>, skills: ReadonlyMap<string, Skill>): void {
  byName("tool", [...tools.values(), ...[...skills.values()].flatMap((s) => s.tools)]);
}

/**
 * Assembles a Catalogue from the items listed. Throws a `KarmiError` when a name repeats within a kind or a
 * code-defined Agent references a missing item.
 */
export function assembleCatalogue(input: CatalogueInput): Catalogue {
  const skills = byName("skill", input.skills ?? []);
  const tools = byName("tool", input.tools ?? []);
  assertOneToolNamespace(tools, skills);
  const fragments = byName("fragment", input.fragments ?? []);
  const retrievers = byName("retriever", input.retrievers ?? []);
  const hooks = byName("hook", input.hooks ?? []);
  const agents = new Map<string, Agent>();
  for (const agent of input.agents ?? []) {
    if (agents.has(agent.agentId))
      throw new KarmiError("name.duplicate", `Duplicate agent "${agent.agentId}" in the Catalogue.`);
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
    fingerprint: () => (fingerprint ??= sha256Hex(JSON.stringify(catalogue.describe()))),
  };
  assertAgentsResolve(catalogue);
  return catalogue;
}

// A code-defined Agent that references a missing Catalogue item is a boot error, like any other dangling name.
function assertAgentsResolve(catalogue: Catalogue): void {
  for (const agent of catalogue.agents.values()) {
    const result = validateAgentSpec(agent.spec, catalogue);
    if (!result.ok) {
      const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      throw new KarmiError(
        "agent.spec.invalid",
        `Agent "${agent.agentId}" does not resolve against the Catalogue: ${detail}`,
      );
    }
  }
}

// Optional keys are omitted rather than set to undefined so the output is stable JSON.
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function describe(c: Omit<Catalogue, "describe">): CatalogueDescription {
  return {
    deliverers: [...c.deliverers.values()].map((d) => ({ name: d.name, granularity: d.granularity ?? "part" })),
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
      invokableBy: s.invokableBy,
      ...optional("settings", s.settings && toJsonSchema(s.settings)),
    })),
    retrievers: [...c.retrievers.values()].map((r) => ({
      name: r.name,
      ...optional("description", r.description),
      ...optional("settings", r.settings && toJsonSchema(r.settings)),
    })),
    hooks: [...c.hooks.values()].map((h) => ({
      name: h.name,
      point: h.point,
      ...optional("description", h.description),
    })),
    agents: [...c.agents.values()].map((a) => ({
      agentId: a.agentId,
      name: a.spec.name,
      ...optional("description", a.spec.description),
    })),
  };
}
