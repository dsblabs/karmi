import * as z from "zod/mini";
import { MediaRefSchema } from "./context";
import type { ToolPending } from "./tool";
import type { ContainerScriptInput } from "./container-types";

/** The budgets one Script runs under. */
export interface ScriptLimits {
  /** CPU time, in milliseconds. */
  cpuMs: number;
  /** Wall-clock time, in milliseconds. */
  wallMs: number;
  /** The number of Tool calls the Script may make. */
  maxToolCalls: number;
}
/** One Tool call a Script made, as recorded in the result. */
export interface ScriptToolCall {
  callId: string;
  name: string;
  isError: boolean;
}
/**
 * What one Script run produced: its returned value or the error that ended it, plus the console
 * output, the Tool calls made and the media it produced.
 */
export const SandboxResultSchema = z.intersection(
  z.union([
    z.object({ value: z.unknown(), error: z.optional(z.never()) }),
    z.object({ error: z.object({ message: z.string(), stack: z.optional(z.string()) }), value: z.optional(z.never()) }),
  ]),
  z.object({
    logs: z.array(z.string()),
    toolCalls: z.array(z.object({ callId: z.string(), name: z.string(), isError: z.boolean() })),
    artifacts: z.array(MediaRefSchema),
  }),
);
/** The decoded result of one Script execution. */
export type SandboxResult = z.infer<typeof SandboxResultSchema>;
/** One Script to run and everything the host lends it. */
export interface SandboxRequest {
  /** The stable Harness call identity, used to distinguish recovery from a new Script. */
  callId?: string;
  /** The shell or Python input, when running the container tier. */
  container?: ContainerScriptInput;
  /** The JavaScript module the model wrote. */
  code: string;
  limits: ScriptLimits;
  signal: AbortSignal;
  /** The names of the Tools the Script may call. */
  tools: readonly string[];
  /** Runs one Tool call on the host and returns its value with the call id it was logged under. */
  call(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ callId: string; value: unknown; isError: boolean }>;
  /** Reads the full value of an earlier Tool result on this Thread by its call id. */
  result(callId: string): Promise<unknown>;
}
/** Runs one Script. A Sandbox holds no authority of its own and reaches only the Tools the request names. */
export interface Sandbox {
  run(request: SandboxRequest): Promise<SandboxResult | ToolPending>;
}
