import { SandboxResultSchema } from "./sandbox";
import * as z from "zod/mini";
import { MediaRefSchema } from "./context";
import type { MediaRef } from "./context";
import type { Capabilities } from "./agent";
import type { Ceilings } from "./scope-config";

/** The container Script input, with safe filenames mapped to existing media references. */
export const ContainerInput = z.object({
  code: z.string(),
  language: z.enum(["shell", "python"]),
  files: z.optional(z.record(z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)), MediaRefSchema)),
});
/** The decoded input of a container Script. */
export type ContainerScriptInput = z.infer<typeof ContainerInput>;
/** The effective budgets of a Workspace and its processes. */
export const ContainerLimitsSchema = z.object({
  wallMs: z.number(),
  jobMaxWallMs: z.number(),
  idleMs: z.number(),
  maxArtifacts: z.number(),
});
/** The effective budgets of a Workspace and its processes. */
export type ContainerLimits = z.infer<typeof ContainerLimitsSchema>;
/** Resolves container budgets under the Scope's Script ceilings. */
export function containerLimits(
  grant: NonNullable<Capabilities["scripts"]>,
  ceiling: Ceilings["scripts"],
): ContainerLimits {
  const max = ceiling ? ceiling.limits : undefined;
  return {
    wallMs: Math.min(grant.limits?.wallMs ?? 60000, max?.wallMs ?? Infinity),
    jobMaxWallMs: Math.min(grant.limits?.jobMaxWallMs ?? 600000, max?.jobMaxWallMs ?? Infinity),
    idleMs: Math.min(grant.limits?.idleMs ?? 60000, max?.idleMs ?? Infinity),
    maxArtifacts: Math.min(grant.limits?.maxArtifacts ?? 20, max?.maxArtifacts ?? Infinity),
  };
}
/** A process snapshot obtained by polling the execution runtime. */
export interface ContainerProcess {
  id: string;
  status: "starting" | "running" | "completed" | "failed" | "killed" | "error";
  exitCode?: number;
}
/** The filesystem and process operations used by a container Sandbox. */
export interface ContainerDriver {
  configure(allow: string[], idleMs: number): Promise<void>;
  prepare(files: Record<string, Uint8Array>): Promise<void>;
  start(code: string, language: "shell" | "python", id: string): Promise<ContainerProcess>;
  process(id: string): Promise<ContainerProcess | null>;
  logs(id: string): Promise<{ stdout: string; stderr: string }>;
  artifacts(max: number, maxBytes: number): AsyncIterable<{ name: string; bytes: Uint8Array }>;
  kill(id: string, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  keepAlive(value: boolean): Promise<void>;
  destroy(): Promise<void>;
}
/** The persisted identity and deadlines of one container Script. */
export const ContainerRunSchema = z.object({
  callId: z.string(),
  completion: z.optional(SandboxResultSchema),
  processId: z.string(),
  startedAt: z.number(),
  deadline: z.number(),
  offset: z.number(),
  limits: ContainerLimitsSchema,
});
/** The process metadata persisted before a Tool call can become a Job. */
export type ContainerRun = z.infer<typeof ContainerRunSchema>;
/** The host operations a container Sandbox uses without exposing them to the Script. */
export interface ContainerHost {
  now(): number;
  read(): ContainerRun | undefined;
  save(run: ContainerRun): void;
  clear(): void;
  progress(id: string, stdout: string): void;
  load(ref: MediaRef): Promise<Uint8Array>;
  store(name: string, bytes: Uint8Array): Promise<MediaRef>;
  maxBytes: number;
}

/** Decodes the persisted container process record at the storage boundary. */
export function decodeContainerRun(json: string): ContainerRun {
  return z.parse(ContainerRunSchema, JSON.parse(json));
}
