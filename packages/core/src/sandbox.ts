import type { MediaRef } from "./context";

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
export type SandboxResult = (
  { value: unknown; error?: never } | { error: { message: string; stack?: string | undefined }; value?: never }
) & {
  logs: string[];
  toolCalls: ScriptToolCall[];
  artifacts: MediaRef[];
};
/** One Script to run and everything the host lends it. */
export interface SandboxRequest {
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
  run(request: SandboxRequest): Promise<SandboxResult>;
}
