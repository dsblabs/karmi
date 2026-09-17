import * as z from "zod/mini";
import { AgentSpecSchema, PROVIDER_TOOL_NAMES } from "./agent-spec";
import { KarmiError } from "./errors";
import type { HookPoint } from "./hook";
import { deepFreeze } from "./names";
import type { SkillInvoker } from "./skill";
import type { ToolAnnotations } from "./tool";
import { firstIssue, pointer } from "./validate";

/** One item in an Agent Spec's ordered instructions. */
export type PromptEntry =
  | { text: string; models?: string | string[] }
  | { fragment: string; args?: Record<string, unknown>; models?: string | string[] };

/** A Tool reference in a Spec: a name alone, or a name with per-reference settings and an `alwaysLoad` pin. */
export type ToolReference = string | { name: string; settings?: Record<string, unknown>; alwaysLoad?: boolean };
/** A Skill reference in a Spec: a name alone, or a name with settings and an `invokableBy` override. */
export type SkillReference = string | { name: string; settings?: Record<string, unknown>; invokableBy?: SkillInvoker };
/** A Knowledge reference in a Spec: a name alone, or a name with a Retriever and a `search` or `inline` mode. */
export type KnowledgeReference =
  | string
  | { name: string; retriever?: string; settings?: Record<string, unknown>; mode?: "search" | "tool" | "inline" };

/**
 * One rule of a Permission Policy. Rules are evaluated in order, the first matching rule decides, and no
 * match means `ask`.
 */
export interface PolicyRule {
  /** The Tool names (globs allowed) and annotation values a Tool must match. */
  match: { tool?: string | string[]; annotations?: Partial<ToolAnnotations> };
  effect: "allow" | "ask" | "deny";
}

/**
 * A Connection this Agent's Tools act through, declared by name. The credential value is set separately
 * and never appears here.
 */
export interface ConnectionDeclaration {
  /** The kind of credential the value is, as the Platform names it. */
  type: string;
  /** Whether the grant is held once for the Agent or by each User. */
  level: "agent" | "user";
  /** Defaults to true. When false, a Tool runs without the Connection when none resolves. */
  required?: boolean;
}

/**
 * The Capability grants of an Agent Spec. Each block belongs to one Capability, and nothing not granted is
 * reachable.
 */
export interface Capabilities {
  scripts?: {
    tier: "isolate" | "container";
    /** Hostnames container Scripts may reach; defaults to none. */
    egress?: { allow: string[] };
    limits?: {
      cpuMs?: number;
      wallMs?: number;
      maxToolCalls?: number;
      idleMs?: number;
      jobMaxWallMs?: number;
      maxArtifacts?: number;
    };
    /** Defaults to `"allowed"`: every allow-resolved Tool, independent of model deferral. An array narrows that set. */
    tools?: "allowed" | string[];
  };
  longRunning?: { maxSteps?: number; maxWallMs?: number; maxTokens?: number };
  delegation?: { maxDepth?: number; maxConcurrent?: number; maxChildren?: number };
  scheduling?: { maxPending?: number; maxHorizonMs?: number; cron?: boolean };
  providerTools?: { tools: ProviderToolName[]; limits?: { maxCallsPerTurn?: number; maxCallsPerThread?: number } };
}

/** The abstract name of a Provider Tool a Spec may grant. */
export type ProviderToolName = (typeof PROVIDER_TOOL_NAMES)[number];

/**
 * The schema of a Memory profile. It is JSON Schema a form can be rendered from: named properties only, no
 * composition or `$ref`.
 */
export interface MemoryProfileSchema {
  type?: "object";
  properties: Record<string, MemoryProfileProperty>;
  required?: string[];
}
/** One property of a Memory profile, in the JSON Schema subset a profile allows. */
export interface MemoryProfileProperty {
  type?: JsonType | JsonType[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: MemoryProfileProperty;
  properties?: Record<string, MemoryProfileProperty>;
  required?: string[];
}
/** A JSON Schema primitive type name. */
export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/**
 * The context-window settings of an Agent Spec. An absent field inherits the Scope, Deployment or Framework
 * default.
 */
export interface ContextConfig {
  /** The model's context window, in tokens. */
  window?: number;
  /** The tokens kept free below the window. Compaction runs when the context would use them. */
  reserveTokens?: number;
  /** The most recent tokens a Compaction keeps verbatim. */
  keepRecentTokens?: number;
  /** The Spill limit for Tool results. */
  toolOutput?: { maxChars?: number; maxLines?: number };
  /** Which Tools defer, and for `auto` the share of the window their definitions may take before they do. */
  tools?: { defer?: "auto" | "always" | "never"; threshold?: number };
}

/**
 * The plain-data description an Agent is born from. Contains no code and no credentials.
 * Written by hand rather than inferred from `AgentSpecSchema` so editor hovers show these names;
 * a test pins the two together.
 */
export interface AgentSpec {
  agentId: string;
  name: string;
  description?: string;
  instructions: PromptEntry[];
  model: {
    id: string;
    /** The Provider profile to run under. Defaults to `default`, or the Scope's only profile. */
    providerProfile?: string;
    /** Models tried in order when `id` cannot be served. */
    fallbacks?: string[];
    params?: {
      temperature?: number;
      topP?: number;
      maxOutputTokens?: number;
      reasoning?: "off" | "low" | "medium" | "high";
    };
    /** Options passed through to the provider adapter unchanged. */
    providerOptions?: Record<string, unknown>;
  };
  tools?: ToolReference[];
  skills?: SkillReference[];
  knowledge?: KnowledgeReference[];
  /** The ids of the Agents this Agent may delegate to. */
  delegates?: string[];
  connections?: Record<string, ConnectionDeclaration>;
  capabilities?: Capabilities;
  memory?: { profile?: MemoryProfileSchema; notes?: boolean };
  policy?: PolicyRule[];
  /** Hook names by lifecycle point, run in this order. */
  hooks?: Partial<Record<HookPoint, string[]>>;
  context?: ContextConfig;
  /** `timeout` is in milliseconds. An Approval that expires is a deny. */
  approvals?: { timeout?: number };
}

/** A code-defined Agent as `defineAgent` returns it: a frozen Spec under its id. */
export interface Agent {
  readonly kind: "agent";
  readonly agentId: string;
  readonly spec: AgentSpec;
}

/**
 * Defines a code-defined Agent for the Catalogue from the same Spec a Platform would `put`. It checks the
 * Spec's shape and throws a `KarmiError` when it is invalid. References are checked against the Catalogue
 * when it is assembled.
 */
export function defineAgent(spec: AgentSpec): Agent {
  const result = z.safeParse(AgentSpecSchema, spec);
  if (!result.success) {
    const first = firstIssue(result.error);
    throw new KarmiError(
      "agent.spec.invalid",
      `Agent Spec "${String(spec.agentId)}" is invalid at "${pointer(first.path)}": ${first.message}`,
    );
  }
  return Object.freeze({ kind: "agent", agentId: spec.agentId, spec: deepFreeze(structuredClone(spec)) });
}
