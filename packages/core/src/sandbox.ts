import type { MediaRef } from "./context";

export interface ScriptLimits {
  cpuMs: number;
  wallMs: number;
  maxToolCalls: number;
}
export interface ScriptToolCall {
  callId: string;
  name: string;
  isError: boolean;
}
export type SandboxResult = (
  { value: unknown; error?: never } | { error: { message: string; stack?: string | undefined }; value?: never }
) & {
  logs: string[];
  toolCalls: ScriptToolCall[];
  artifacts: MediaRef[];
};
export interface SandboxRequest {
  code: string;
  limits: ScriptLimits;
  signal: AbortSignal;
  tools: readonly string[];
  call(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ callId: string; value: unknown; isError: boolean }>;
  result(callId: string): Promise<unknown>;
}
/** One execution, with no ambient authority: the host supplies every reachable Tool. */
export interface Sandbox {
  run(request: SandboxRequest): Promise<SandboxResult>;
}
