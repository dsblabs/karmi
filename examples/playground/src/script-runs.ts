import type { ScriptLimits, ThreadEvent } from "@karmi/core";
import { z } from "zod";

const scriptInputSchema = z.object({ code: z.string(), description: z.string().optional() });

// The text of a `run_script` result. The Harness writes it as JSON.
const scriptResultSchema = z.object({
  value: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  logs: z.array(z.string()).default([]),
});

/** One Tool call that a Script made, from the `tool.call` and `tool.result` events with its `parentCallId`. */
export interface NestedCall {
  /** The call id of the nested call, `{threadId}:{seq}`. */
  callId: string;
  /** The call id of the `run_script` call that made this call. */
  parentCallId: string;
  name: string;
  input: unknown;
  /** Undefined while the call runs. */
  isError?: boolean;
  /** True when a cancel or an eviction ended the call before it reported a result. The call may have taken effect. */
  interrupted?: boolean;
}

/** How a Script ended, or `running` while it runs. */
export type ScriptOutcome =
  | { state: "running" }
  /** `value` is what the default export of the Script returned. */
  | { state: "done"; value: unknown }
  /** `error` is the message of the Script or the Harness. `explanation` is present when the scenario knows the cause. */
  | { state: "failed"; error: string; explanation?: string }
  /** A cancel or an eviction ended the Script before it reported a result. */
  | { state: "stopped"; explanation: string };

/** One `run_script` call of the Thread, with its outcome, its console lines and the Tool calls that the Script made. */
export type ScriptRun = ScriptOutcome & {
  /** The call id of the `run_script` call, `{threadId}:{seq}`. */
  callId: string;
  /** The code that ran, as the model sent it. */
  code: string;
  logs: string[];
  calls: NestedCall[];
};

/** Tells what a Script error means for the given limits. Returns undefined for an error that the Script threw. */
export function explainScriptError(message: string, limits: ScriptLimits): string | undefined {
  if (message.includes("limit_exceeded: maxToolCalls"))
    return `The Script asked for more than ${String(limits.maxToolCalls)} Tool calls, the maxToolCalls limit. The Harness refused the next call and ended the Script with this error, also when the Script catches it.`;
  if (message.includes("limit_exceeded: wallMs"))
    return `The Script ran for more than ${String(limits.wallMs)} ms, the wallMs limit. The Harness stopped it.`;
  if (message.includes("limit_exceeded: cpuMs"))
    return `The Script used more than ${String(limits.cpuMs)} ms of CPU time, the cpuMs limit. Cloudflare stopped it. Local workerd does not enforce this limit.`;
  if (/tools\.\w+ is not a function/.test(message))
    return "The Script gets only the Tools that the Permission Policy allows. A Tool that needs an Approval is not in tools, because a Script cannot wait for an Approval.";
  if (message.includes("not permitted to access the internet"))
    return "A Script has no network access. The isolate has no outbound connection, thus each fetch fails.";
  return undefined;
}

const STOPPED =
  "A cancel or an eviction ended the Script before it reported a result. The Script cannot call a Tool any more. A change that a Tool made before stays. A Tool call that was in progress is interrupted: it may have taken effect.";

/**
 * Returns each `run_script` call of an event log with its outcome and its nested Tool calls. A nested call has the
 * `parentCallId` of its Script. A Script with an interrupted result is `stopped`.
 */
export function scriptRuns(threadId: string, events: readonly ThreadEvent[], limits: ScriptLimits): ScriptRun[] {
  const runs = new Map<string, ScriptRun>();
  // The Provider id of a call that runs, mapped to the call id of its run. A Provider can use the same id again in a
  // later Step, thus a result finds only a run that has no result yet.
  const open = new Map<string, string>();
  // The Harness gives each call of a Script its own id, `{parentCallId}/script/{n}`, thus these ids never repeat.
  const nested = new Map<string, NestedCall>();
  const finish = (callId: string, outcome: ScriptOutcome, logs: string[] = []) => {
    const run = runs.get(callId);
    if (run) runs.set(callId, { callId, code: run.code, calls: run.calls, logs, ...outcome });
  };
  for (const event of events) {
    const callId = `${threadId}:${String(event.seq)}`;
    if (event.type === "tool.call" && event.parentCallId) {
      const call = { callId, parentCallId: event.parentCallId, name: event.name, input: event.input };
      nested.set(event.id, call);
      runs.get(event.parentCallId)?.calls.push(call);
    } else if (event.type === "tool.result" && event.parentCallId) {
      const call = nested.get(event.id);
      if (call) {
        call.isError = event.isError;
        if (event.interrupted) call.interrupted = true;
      }
    } else if (event.type === "tool.call" && event.name === "run_script") {
      const input = scriptInputSchema.safeParse(event.input);
      runs.set(callId, { callId, code: input.success ? input.data.code : "", state: "running", logs: [], calls: [] });
      open.set(event.id, callId);
    } else if (event.type === "tool.result" && event.name === "run_script") {
      const run = open.get(event.id);
      if (run === undefined) continue;
      open.delete(event.id);
      if (event.interrupted) {
        finish(run, { state: "stopped", explanation: STOPPED });
        continue;
      }
      const { outcome, logs } = readResult(event.content, event.isError, limits);
      finish(run, outcome, logs);
    }
  }
  return [...runs.values()];
}

function readResult(
  content: readonly { type: string; text?: string }[],
  isError: boolean,
  limits: ScriptLimits,
): { outcome: ScriptOutcome; logs: string[] } {
  const text = content.map((block) => block.text ?? "").join("");
  let parsed;
  try {
    parsed = scriptResultSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  // A result that is not the JSON of the Sandbox is an error of the Harness, for example a missing binding.
  if (!parsed?.success) return { outcome: { state: "failed", error: text }, logs: [] };
  const { value, error, logs } = parsed.data;
  if (!isError && !error) return { outcome: { state: "done", value }, logs };
  const message = error?.message ?? text;
  const explanation = explainScriptError(message, limits);
  return { outcome: { state: "failed", error: message, ...(explanation && { explanation }) }, logs };
}
