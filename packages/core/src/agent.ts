import * as z from "zod/mini";
import { AgentSpecSchema, PROVIDER_TOOL_NAMES } from "./agent-spec.js";
import { KarmiError } from "./errors.js";
import type { HookPoint } from "./hook.js";
import { deepFreeze } from "./names.js";
import type { ToolAnnotations } from "./tool.js";
import { pointer } from "./validate.js";

/** One item in an Agent Spec's ordered instructions. */
export type PromptEntry =
  | { text: string; models?: string | string[] }
  | { fragment: string; args?: Record<string, unknown>; models?: string | string[] };

export type ToolReference = string | { name: string; settings?: Record<string, unknown>; alwaysLoad?: boolean };
export type SkillReference =
  string | { name: string; settings?: Record<string, unknown>; invokableBy?: "model" | "user" | "both" };
export type KnowledgeReference = string | { name: string; retriever?: string; mode?: "tool" | "inline" };

/** Ordered; the first matching rule decides, and no match means `ask`. */
export interface PolicyRule {
  match: { tool?: string | string[]; annotations?: Partial<ToolAnnotations> };
  effect: "allow" | "ask" | "deny";
}

/** A named credential grant this Agent's Tools act through; the value is set separately, never here. */
export interface ConnectionDeclaration {
  type: string;
  level: "agent" | "user";
  required?: boolean;
}

/** Each Capability block is owned by that Capability; `egress` is reserved for the container tier. */
export interface Capabilities {
  scripts?: {
    tier: "isolate" | "container";
    limits?: {
      cpuMs?: number;
      wallMs?: number;
      maxToolCalls?: number;
      idleMs?: number;
      jobMaxWallMs?: number;
      maxArtifacts?: number;
    };
    /** Which of the Agent's Tools a Script may call; `"allowed"` means every allow-resolved one. */
    tools?: "allowed" | string[];
  };
  longRunning?: { maxSteps?: number; maxWallMs?: number; maxTokens?: number };
  delegation?: { maxDepth?: number; maxConcurrent?: number; maxChildren?: number };
  scheduling?: { maxPending?: number; maxHorizonMs?: number; cron?: boolean };
  providerTools?: { tools: ProviderToolName[]; limits?: { maxCallsPerTurn?: number; maxCallsPerThread?: number } };
}

export type ProviderToolName = (typeof PROVIDER_TOOL_NAMES)[number];

/** JSON Schema a form can be rendered from: named properties only, no composition or `$ref`. */
export interface MemoryProfileSchema {
  type?: "object";
  properties: Record<string, MemoryProfileProperty>;
  required?: string[];
}
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
export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Context-window management; absent fields inherit the Scope, Deployment or Framework default. */
export interface ContextConfig {
  window?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  toolOutput?: { maxChars?: number; maxLines?: number };
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
    providerProfile?: string;
    fallbacks?: string[];
    params?: {
      temperature?: number;
      topP?: number;
      maxOutputTokens?: number;
      reasoning?: "off" | "low" | "medium" | "high";
    };
    providerOptions?: Record<string, unknown>;
  };
  tools?: ToolReference[];
  skills?: SkillReference[];
  knowledge?: KnowledgeReference[];
  delegates?: string[];
  connections?: Record<string, ConnectionDeclaration>;
  capabilities?: Capabilities;
  memory?: { profile?: MemoryProfileSchema; notes?: boolean };
  policy?: PolicyRule[];
  hooks?: Partial<Record<HookPoint, string[]>>;
  context?: ContextConfig;
  /** `timeout` in milliseconds; an expired Approval is a deny. */
  approvals?: { timeout?: number };
}

export interface Agent {
  readonly kind: "agent";
  readonly agentId: string;
  readonly spec: AgentSpec;
}

/**
 * A code-defined Agent: the same Spec a Platform would `put`, seeded into a Scope lazily.
 * Checks the shape here; references are checked against the Catalogue when it is assembled.
 */
export function defineAgent(spec: AgentSpec): Agent {
  const result = z.safeParse(AgentSpecSchema, spec);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new KarmiError(
      "agent.spec.invalid",
      `Agent Spec "${String(spec.agentId)}" is invalid at "${pointer(first.path)}": ${first.message}`,
    );
  }
  return Object.freeze({ kind: "agent", agentId: spec.agentId, spec: deepFreeze(structuredClone(spec)) });
}
