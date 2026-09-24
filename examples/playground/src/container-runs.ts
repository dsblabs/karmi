import type { MediaRef, ThreadEvent } from "@karmi/core";
import { z } from "zod";
import { mediaRefSchema } from "./media-download";

const inputSchema = z.object({
  code: z.string(),
  language: z.string(),
  files: z.record(z.string(), z.unknown()).optional(),
});

// The text of a container `run_script` result. The Harness writes the result of the Sandbox as JSON.
const resultSchema = z.object({
  value: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }).optional(),
  error: z.object({ message: z.string() }).optional(),
  artifacts: z.array(mediaRefSchema).default([]),
});

/** How a container Script ended, or where it is while it runs. */
export type ContainerOutcome =
  /** The call runs and waits for the process. */
  | { state: "running" }
  /** The process ran longer than `wallMs`. The Turn is parked on the Job of the process. */
  | { state: "job" }
  /** The process exited with code 0. `stdout` and `stderr` are its output. */
  | { state: "done"; stdout: string; stderr: string; exitCode: number }
  /** The process failed, or the Harness could not run it. `error` is the message. */
  | { state: "failed"; error: string }
  /** The operator cancelled the Turn. The Harness stopped the process and destroyed the Workspace. */
  | { state: "cancelled" }
  /** The Turn ended before the Script reported a result. */
  | { state: "stopped" };

/** What the page shows of one container `run_script` call, other than its outcome. */
export interface RunFields {
  /** The call id of the `run_script` call, `{threadId}:{seq}`. */
  callId: string;
  language: string;
  /** The code that ran, as the model sent it. */
  code: string;
  /** The names of the input files that the call wrote to `/in`. */
  files: string[];
  /** The id of the Job, when the process became one. */
  jobId?: string;
  /** The output that the Job reported while the process ran. */
  progress: string;
  /** The files that the Script wrote to `/out`. Each one is media of the Thread. */
  artifacts: MediaRef[];
  /** The hostnames that the container proxy denied, from the stderr of the process. */
  denied: string[];
}

/** One container `run_script` call of the Thread, with its outcome, its Job progress and its artifacts. */
export type ContainerRun = ContainerOutcome &
  RunFields & {
    /** A plain explanation of the outcome, when the scenario knows its cause. */
    explanation?: string;
  };

/** Tells what the outcome of a run means. Returns undefined when the outcome needs no explanation. */
function explain(run: ContainerRun): string | undefined {
  if (run.denied.length > 0)
    return `The Worker denied ${run.denied.join(", ")}. A container Script reaches only the hostnames in capabilities.scripts.egress.allow of its Agent. The proxy answers each other request with HTTP 520 and adds a line to stderr.`;
  if (run.state === "job")
    return "The process ran longer than wallMs, thus it became a Job and the Turn is parked. The Thread reads the output every five seconds and adds it as progress. Cancel the Turn to stop the process.";
  if (run.state === "cancelled")
    return "The cancel sent SIGTERM to the process, then SIGKILL if it did not stop. The Harness then destroyed the Workspace with its files.";
  if (run.state === "stopped") return "The Turn ended before the Script finished.";
  if (run.state !== "failed") return undefined;
  if (run.error.includes("container_lost"))
    return "The process no longer exists, for example because the container stopped. The Thread cannot read its result.";
  if (run.error.includes("jobMaxWallMs")) return "The process ran longer than jobMaxWallMs. The Harness stopped it.";
  if (run.error.includes("KARMI_SANDBOX"))
    return "The Worker has no container runtime. Start the Playground with pnpm dev:containers, or deploy it with container Scripts.";
  return undefined;
}

const DENIED = /Egress denied \(520\): ([^;\s]+)/g;

/** Reads the result of a container `run_script` call. A text that is not JSON is an error of the Harness. */
function readResult(text: string, isError: boolean): { outcome: ContainerOutcome; artifacts: MediaRef[] } {
  if (text === "Job cancelled.") return { outcome: { state: "cancelled" }, artifacts: [] };
  let parsed;
  try {
    parsed = resultSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) return { outcome: { state: "failed", error: text }, artifacts: [] };
  const { value, error, artifacts } = parsed.data;
  if (value && !isError && !error) return { outcome: { state: "done", ...value }, artifacts };
  return { outcome: { state: "failed", error: error?.message ?? text }, artifacts };
}

/**
 * Returns each container `run_script` call of an event log with its outcome. A call that became a Job gets the
 * progress of the Job. A call without a result when its Turn ends is `stopped`.
 */
export function containerRuns(threadId: string, events: readonly ThreadEvent[]): ContainerRun[] {
  const runs = new Map<string, { fields: RunFields; outcome: ContainerOutcome }>();
  // The Provider id of a call that runs, mapped to the call id of its run. A Provider can use the same id again in a
  // later Step, thus a result finds only a run that has no result yet.
  const open = new Map<string, string>();
  const jobs = new Map<string, string>();
  const textOf = (content: readonly { type: string; text?: string }[]) =>
    content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
  for (const event of events) {
    const callId = `${threadId}:${String(event.seq)}`;
    if (event.type === "tool.call" && event.name === "run_script" && !event.parentCallId) {
      const input = inputSchema.safeParse(event.input);
      const fields: RunFields = {
        callId,
        language: input.success ? input.data.language : "",
        code: input.success ? input.data.code : "",
        files: input.success ? Object.keys(input.data.files ?? {}) : [],
        progress: "",
        artifacts: [],
        denied: [],
      };
      runs.set(callId, { fields, outcome: { state: "running" } });
      open.set(event.id, callId);
    } else if (event.type === "job.started") {
      const run = runs.get(open.get(event.id) ?? "");
      if (!run) continue;
      jobs.set(event.jobId, run.fields.callId);
      run.fields.jobId = event.jobId;
      run.outcome = { state: "job" };
    } else if (event.type === "job.cancelled") {
      // A cancelled Job ends its Turn, and no result of the call follows.
      const run = runs.get(jobs.get(event.jobId) ?? "");
      if (!run) continue;
      run.outcome = { state: "cancelled" };
      for (const [id, callId] of open) if (callId === run.fields.callId) open.delete(id);
    } else if (event.type === "job.progress") {
      const run = runs.get(jobs.get(event.jobId) ?? "");
      if (run) run.fields.progress += textOf(event.content);
    } else if (event.type === "tool.result" && event.name === "run_script") {
      const run = runs.get(open.get(event.id) ?? "");
      if (!run) continue;
      open.delete(event.id);
      const { outcome, artifacts } = readResult(textOf(event.content), event.isError);
      const stderr = outcome.state === "done" ? outcome.stderr : outcome.state === "failed" ? outcome.error : "";
      run.fields.artifacts = artifacts;
      run.fields.denied = [...new Set([...stderr.matchAll(DENIED)].flatMap(([, host]) => (host ? [host] : [])))];
      run.outcome = outcome;
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      for (const id of open.values()) {
        const run = runs.get(id);
        if (run) run.outcome = { state: "stopped" };
      }
      open.clear();
    }
  }
  return [...runs.values()].map(({ fields, outcome }) => {
    const run: ContainerRun = { ...fields, ...outcome };
    const explanation = explain(run);
    return explanation ? { ...run, explanation } : run;
  });
}
