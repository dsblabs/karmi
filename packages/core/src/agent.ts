import type { HookPoint } from "./hook.js";
import { assertIdentifier, deepFreeze } from "./names.js";

/** One item in an Agent Spec's ordered instructions. */
export type PromptEntry = { text: string; models?: string | string[] } | { fragment: string; args?: Record<string, unknown>; models?: string | string[] };

export type ToolReference = string | { name: string; settings?: Record<string, unknown>; alwaysLoad?: boolean };
export type SkillReference = string | { name: string; settings?: Record<string, unknown>; invokableBy?: "model" | "user" | "both" };
export type KnowledgeReference = string | { name: string; retriever?: string; mode?: "tool" | "inline" };

export interface PolicyRule {
  match: { tool?: string | string[]; annotations?: Record<string, boolean> };
  effect: "allow" | "ask" | "deny";
}

/**
 * The plain-data description an Agent is born from. Contains no code and no credentials.
 * Shape-level validation lands with the Agent Spec schema (wayfinder #42).
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
    params?: { temperature?: number; topP?: number; maxOutputTokens?: number; reasoning?: "off" | "low" | "medium" | "high" };
    providerOptions?: Record<string, unknown>;
  };
  tools?: ToolReference[];
  skills?: SkillReference[];
  knowledge?: KnowledgeReference[];
  delegates?: string[];
  connections?: Record<string, { type: string; level: "agent" | "user"; required?: boolean }>;
  capabilities?: Record<string, unknown>;
  memory?: { profile?: Record<string, unknown>; notes?: boolean };
  policy?: PolicyRule[];
  hooks?: Partial<Record<HookPoint, string[]>>;
  context?: Record<string, unknown>;
  approvals?: { timeout?: number };
}

export interface Agent {
  readonly kind: "agent";
  readonly agentId: string;
  readonly spec: AgentSpec;
}

/** A code-defined Agent: the same Spec a Platform would `put`, seeded into a Scope lazily. */
export function defineAgent(spec: AgentSpec): Agent {
  assertIdentifier("agent.id.invalid", "agentId", spec.agentId);
  return Object.freeze({ kind: "agent", agentId: spec.agentId, spec: deepFreeze(structuredClone(spec)) });
}
