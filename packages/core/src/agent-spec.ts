import * as z from "zod/mini";
import { HOOK_POINTS } from "./hook";
import { IDENTIFIER } from "./names";
import { toJsonSchema, type JsonSchema } from "./schema";
import { SKILL_INVOKERS } from "./skill";

// The shape layer of Agent Spec validation. It checks what a Spec looks like before any Catalogue or Scope
// is consulted.

const identifier = z.string().check(z.regex(IDENTIFIER, "must match [A-Za-z0-9_-]{1,64}"));
/** The schema of a Catalogue item name: a non-empty string. */
export const name = z.string().check(z.minLength(1));
const modelId = z.string().check(z.regex(/^[a-z0-9_-]+\/.+$/, "must be provider/model"));
const modelGlob = z.union([z.string().check(z.minLength(1)), z.array(z.string().check(z.minLength(1)))]);
/** The schema of a positive integer, used for every numeric limit in a Spec. */
export const positiveInt = z.int().check(z.positive());
const settings = z.optional(z.record(z.string(), z.unknown()));

const PromptEntrySchema = z.union([
  z.strictObject({ text: z.string(), models: z.optional(modelGlob) }),
  z.strictObject({
    fragment: name,
    args: z.optional(z.record(z.string(), z.unknown())),
    models: z.optional(modelGlob),
  }),
]);

// Every reference list accepts a bare name or an object; normalisation makes them all objects.
function reference<Shape extends z.core.$ZodLooseShape>(extra: Shape) {
  const object = z.strictObject({ name, ...extra });
  return z.pipe(
    z.union([name, object]),
    z.transform((ref) => (typeof ref === "string" ? ({ name: ref } as z.output<typeof object>) : ref)),
  );
}

const ToolReferenceSchema = reference({ settings, alwaysLoad: z.optional(z.boolean()) });
const SkillReferenceSchema = reference({ settings, invokableBy: z.optional(z.enum(SKILL_INVOKERS)) });
const KnowledgeReferenceSchema = reference({
  retriever: z.optional(name),
  mode: z.optional(z.enum(["tool", "inline"])),
});

const ModelSchema = z.strictObject({
  id: modelId,
  providerProfile: z.optional(name),
  fallbacks: z.optional(z.array(modelId)),
  params: z.optional(
    z.strictObject({
      temperature: z.optional(z.number().check(z.gte(0), z.lte(2))),
      topP: z.optional(z.number().check(z.gte(0), z.lte(1))),
      maxOutputTokens: z.optional(positiveInt),
      reasoning: z.optional(z.enum(["off", "low", "medium", "high"])),
    }),
  ),
  providerOptions: z.optional(z.record(z.string(), z.unknown())),
});

const ConnectionDeclarationSchema = z.strictObject({
  type: name,
  level: z.enum(["agent", "user"]),
  required: z.optional(z.boolean()),
});

/** The abstract names a Spec may grant under the `providerTools` Capability. */
export const PROVIDER_TOOL_NAMES = ["web_search", "web_fetch"] as const;

/** The numeric limits of each Capability. The Scope ceilings that bound them use the same schemas. */
export const CapabilityLimitSchemas = {
  scripts: z.strictObject({
    cpuMs: z.optional(positiveInt),
    wallMs: z.optional(positiveInt),
    maxToolCalls: z.optional(positiveInt),
    idleMs: z.optional(positiveInt),
    jobMaxWallMs: z.optional(positiveInt),
    maxArtifacts: z.optional(positiveInt),
  }),
  longRunning: z.strictObject({
    maxSteps: z.optional(positiveInt),
    maxWallMs: z.optional(positiveInt),
    maxTokens: z.optional(positiveInt),
  }),
  delegation: z.strictObject({
    maxDepth: z.optional(positiveInt),
    maxConcurrent: z.optional(positiveInt),
    maxChildren: z.optional(positiveInt),
  }),
  scheduling: z.strictObject({ maxPending: z.optional(positiveInt), maxHorizonMs: z.optional(positiveInt) }),
  providerTools: z.strictObject({
    maxCallsPerTurn: z.optional(positiveInt),
    maxCallsPerThread: z.optional(positiveInt),
  }),
};
/** The schema of a Script tier: `isolate` or `container`. */
export const ScriptTierSchema = z.enum(["isolate", "container"]);
/** The schema of a Provider Tool name. */
export const ProviderToolNameSchema = z.enum(PROVIDER_TOOL_NAMES);

// Each Capability owns its block. The key set is closed so a typo can never grant something by accident.
const CapabilitiesSchema = z.strictObject({
  scripts: z.optional(
    z.strictObject({
      tier: ScriptTierSchema,
      limits: z.optional(CapabilityLimitSchemas.scripts),
      tools: z.optional(z.union([z.literal("allowed"), z.array(name)])),
    }),
  ),
  longRunning: z.optional(CapabilityLimitSchemas.longRunning),
  delegation: z.optional(CapabilityLimitSchemas.delegation),
  scheduling: z.optional(z.extend(CapabilityLimitSchemas.scheduling, { cron: z.optional(z.boolean()) })),
  providerTools: z.optional(
    z.strictObject({
      tools: z.array(ProviderToolNameSchema),
      limits: z.optional(CapabilityLimitSchemas.providerTools),
    }),
  ),
});

// A Memory profile is JSON Schema a form can be rendered from: named properties, no composition, no references.
const jsonType = z.enum(["string", "number", "integer", "boolean", "array", "object", "null"]);
// The schema is recursive, so its annotation is the loose base type. `MemoryProfileProperty` in agent.ts is
// the readable equivalent.
const ProfilePropertySchema: z.ZodMiniType = z.lazy(() =>
  z.strictObject({
    type: z.optional(z.union([jsonType, z.array(jsonType)])),
    description: z.optional(z.string()),
    enum: z.optional(z.array(z.unknown())),
    const: z.optional(z.unknown()),
    default: z.optional(z.unknown()),
    format: z.optional(z.string()),
    pattern: z.optional(z.string()),
    minimum: z.optional(z.number()),
    maximum: z.optional(z.number()),
    minLength: z.optional(z.int()),
    maxLength: z.optional(z.int()),
    items: z.optional(ProfilePropertySchema),
    properties: z.optional(z.record(z.string(), ProfilePropertySchema)),
    required: z.optional(z.array(z.string())),
  }),
);
const MemoryProfileSchema = z.strictObject({
  type: z.optional(z.literal("object")),
  properties: z.record(z.string(), ProfilePropertySchema),
  required: z.optional(z.array(z.string())),
});

/** The schema of one Permission Policy rule. */
export const PolicyRuleSchema = z.strictObject({
  match: z.strictObject({
    tool: z.optional(z.union([z.string().check(z.minLength(1)), z.array(z.string().check(z.minLength(1)))])),
    annotations: z.optional(
      z.strictObject({
        readOnlyHint: z.optional(z.boolean()),
        destructiveHint: z.optional(z.boolean()),
        idempotentHint: z.optional(z.boolean()),
        openWorldHint: z.optional(z.boolean()),
      }),
    ),
  }),
  effect: z.enum(["allow", "ask", "deny"]),
});

const ContextSchema = z.strictObject({
  window: z.optional(positiveInt),
  reserveTokens: z.optional(positiveInt),
  keepRecentTokens: z.optional(positiveInt),
  toolOutput: z.optional(z.strictObject({ maxChars: z.optional(positiveInt), maxLines: z.optional(positiveInt) })),
  tools: z.optional(
    z.strictObject({
      defer: z.optional(z.enum(["auto", "always", "never"])),
      threshold: z.optional(z.number().check(z.gt(0), z.lte(1))),
    }),
  ),
});

/** The schema of an Agent Spec. Parsing turns every bare reference name into an object. */
export const AgentSpecSchema = z.strictObject({
  agentId: identifier,
  name: name,
  description: z.optional(z.string()),
  instructions: z.array(PromptEntrySchema),
  model: ModelSchema,
  tools: z.optional(z.array(ToolReferenceSchema)),
  skills: z.optional(z.array(SkillReferenceSchema)),
  knowledge: z.optional(z.array(KnowledgeReferenceSchema)),
  delegates: z.optional(z.array(identifier)),
  connections: z.optional(z.record(name, ConnectionDeclarationSchema)),
  capabilities: z.optional(CapabilitiesSchema),
  memory: z.optional(z.strictObject({ profile: z.optional(MemoryProfileSchema), notes: z.optional(z.boolean()) })),
  policy: z.optional(z.array(PolicyRuleSchema)),
  hooks: z.optional(z.partialRecord(z.enum(HOOK_POINTS), z.array(name))),
  context: z.optional(ContextSchema),
  approvals: z.optional(z.strictObject({ timeout: z.optional(positiveInt) })),
});

/** An Agent Spec after shape validation: every reference is an object, nothing else is changed. */
export type NormalizedAgentSpec = z.output<typeof AgentSpecSchema>;

/** The Spec's shape as JSON Schema (draft 2020-12), for Platform editors. */
export const agentSpecJsonSchema: JsonSchema = toJsonSchema(AgentSpecSchema);

/**
 * The values the Harness uses when a Spec's `context`, `approvals` or `delegation` says nothing. They are
 * never written into a stored Spec, because an absent field means "inherit" and a Deployment or Scope
 * default may still apply.
 */
export const AGENT_SPEC_DEFAULTS = Object.freeze({
  delegation: Object.freeze({ maxDepth: 4, maxConcurrent: 8, maxChildren: 32 }),
  context: Object.freeze({
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    toolOutput: Object.freeze({ maxChars: 30_000, maxLines: 2_000 }),
    tools: Object.freeze({ defer: "auto" as const, threshold: 0.1 }),
  }),
  approvals: Object.freeze({ timeout: 24 * 60 * 60 * 1000 }),
});
