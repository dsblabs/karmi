import { ContainerInput } from "./container-types";
import * as z from "zod/mini";
import type { Capabilities, AgentSpec } from "./agent";
import type { Ceilings } from "./scope-config";
import type { ScriptLimits, Sandbox } from "./sandbox";
import { toJsonSchema, type JsonSchema } from "./schema";
import { DEFAULT_ANNOTATIONS, type Tool } from "./tool";
import type { AvailableTool } from "./tools";
const SCRIPT_EXCLUDED_TOOLS = new Set(["run_script", "delegate"]);

/** The Script limits that apply when the `scripts` grant sets none. */
export const SCRIPT_DEFAULTS: ScriptLimits = Object.freeze({ cpuMs: 1000, wallMs: 60000, maxToolCalls: 100 });
/** The Script limits for an Agent: the grant's values, else the defaults, each capped by the Scope ceiling. */
export function resolveScriptLimits(
  grant: NonNullable<Capabilities["scripts"]>,
  ceiling: Ceilings["scripts"],
): ScriptLimits {
  const max = ceiling ? ceiling.limits : undefined;
  return {
    cpuMs: Math.min(grant.limits?.cpuMs ?? SCRIPT_DEFAULTS.cpuMs, max?.cpuMs ?? Infinity),
    wallMs: Math.min(grant.limits?.wallMs ?? SCRIPT_DEFAULTS.wallMs, max?.wallMs ?? Infinity),
    maxToolCalls: Math.min(grant.limits?.maxToolCalls ?? SCRIPT_DEFAULTS.maxToolCalls, max?.maxToolCalls ?? Infinity),
  };
}

/**
 * The Tools a Script may call: every allowed Tool the grant selects, with Deferred Tools treated as
 * loaded. A Tool the Permission Policy does not allow, or that needs a user-level Connection on a
 * user-less Thread, is never reachable. `run_script` and `delegate` are excluded.
 */
export function scriptTools(
  spec: AgentSpec,
  available: ReadonlyMap<string, AvailableTool>,
  user?: string,
): Map<string, AvailableTool> {
  const selected = spec.capabilities?.scripts?.tools ?? "allowed";
  return new Map(
    [...available]
      .filter(([name, entry]) => {
        if (SCRIPT_EXCLUDED_TOOLS.has(name) || entry.effect !== "allow" || entry.scriptUnavailable) return false;
        if (selected !== "allowed" && !selected.includes(name)) return false;
        if (entry.tool.requires && spec.connections?.[entry.tool.requires]?.level === "user" && user === undefined)
          return false;
        return true;
      })
      .map(([name, entry]) => [
        name,
        { tool: entry.tool, settings: entry.settings, effect: entry.effect, deferred: false },
      ]),
  );
}

/** The input schema of the `run_script` Tool. */
export const ScriptInput = z.object({ code: z.string(), description: z.optional(z.string()) });
/**
 * The built-in `run_script` Tool for an Agent. Its usage Fragment declares the reachable Tools. Its
 * `execute` always throws, because the Harness gate runs Scripts with the current tool Step's host.
 */
export function scriptTool(spec: AgentSpec, available: () => ReadonlyMap<string, AvailableTool>, user?: string): Tool {
  return {
    kind: "tool",
    name: "run_script",
    description:
      spec.capabilities?.scripts?.tier === "container"
        ? "Run shell or Python in the Thread Workspace. Read named files in /in and write artifacts to /out. No Tools or secrets are available."
        : "Run a one-shot JavaScript module in an isolate. Export a default async function returning the value to keep.",
    input: spec.capabilities?.scripts?.tier === "container" ? ContainerInput : ScriptInput,
    annotations: DEFAULT_ANNOTATIONS,
    instructions: { kind: "fragment", name: "script-usage", render: () => scriptUsage(spec, available(), user) },
    execute: () => {
      throw new Error("run_script requires the Harness gate.");
    },
  };
}

function scriptUsage(spec: AgentSpec, available: ReadonlyMap<string, AvailableTool>, user?: string): string {
  if (spec.capabilities?.scripts?.tier === "container")
    return "Use run_script with code, language (shell or python), and optional files (names mapped to MediaRefs). Read /in; write /out. Egress requires capabilities.scripts.egress.allow. Long scripts become Jobs.";
  const tools = scriptTools(spec, available, user);
  const unavailable = [...available.values()]
    .filter(
      (entry) =>
        entry.effect === "allow" &&
        (entry.scriptUnavailable ||
          (entry.tool.requires && spec.connections?.[entry.tool.requires]?.level === "user" && user === undefined)),
    )
    .map((entry) => entry.tool.name);
  const declarations = [...tools.values()].map(
    ({ tool }) => `${JSON.stringify(tool.name)}(input: ${schemaType(toJsonSchema(tool.input))}): Promise<unknown>;`,
  );
  return [
    "# Scripts",
    "Use run_script with a JS module: export default async () => { return await tools.name(input); };",
    "Only the declared tools are reachable. Calls pass through validation and Hooks. No network, secrets or storage. Tool failures throw. Return only the data needed; console output and a compact call summary are captured. __result(callId) reads a prior result on this Thread.",
    "```ts",
    `declare const tools: {\n${declarations.join("\n")}\n};`,
    "declare function __result(callId: string): Promise<unknown>;",
    "```",
    ...(unavailable.length ? [`Unavailable on this user-less Thread: ${unavailable.join(", ")}.`] : []),
  ].join("\n");
}

function schemaType(schema: unknown): string {
  if (!isSchema(schema)) return "unknown";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "never";
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((value) => schemaType(value)).join(" | ");
  if (schema.type === "string" || schema.type === "boolean" || schema.type === "null") return schema.type;
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "array") return `Array<${schemaType(schema.items ?? {})}>`;
  if (schema.type === "object") {
    const required = Array.isArray(schema.required) ? schema.required : [];
    return `{ ${Object.entries(isSchema(schema.properties) ? schema.properties : {})
      .map(([name, value]) => `${JSON.stringify(name)}${required.includes(name) ? "" : "?"}: ${schemaType(value)}`)
      .join("; ")} }`;
  }
  return "unknown";
}

/** What the Harness gate needs to run one Script. */
export interface ScriptExecution {
  sandbox: Sandbox;
  limits: ScriptLimits;
  /** Reads the full value of an earlier Tool result on this Thread by its call id. */
  result(callId: string): Promise<unknown>;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
