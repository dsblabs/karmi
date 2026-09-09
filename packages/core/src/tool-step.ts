import * as z from "zod/mini";
import type { AgentSpec } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import type { Logger, MediaRef, ScopeId, UserId } from "./context.js";
import type { HookContextBase, HookContexts, HookToolCall } from "./hook.js";
import { hooksAt } from "./hooks.js";
import { keys } from "./keys.js";
import { isPlatformFailure } from "./platform-failure.js";
import { renderTruncated, truncateOutput } from "./spill.js";
import type { ApprovalAnswer, PauseReason, ThreadEvent, ThreadEventData } from "./thread-events.js";
import { DEFAULT_ANNOTATIONS, type Connection, type Tool, type ToolContent, type ToolContext, type ToolOutcome, type ToolResult } from "./tool.js";
import { outputLimits, type AvailableTool } from "./tools.js";

// One tool Step: the model's tool-call batch run under the Harness gate. Read-only Tools run in
// parallel, anything else alone; every call is logged before it runs and its result as soon as it
// lands, so a re-run after an eviction knows exactly what already happened. Calls the Policy asks
// about, and calls a Tool handed to a Job, park the Step: allowed calls run first, then the Step
// returns the reason it waits and re-runs once the log holds the answers.

/** What the Step reads from and writes to: the Thread DO, narrowed to what a batch needs. */
export interface ToolStepHost {
  scope: ScopeId;
  user?: UserId;
  threadId: string;
  agent: string;
  turn: number;
  /** Recovery attempt of this Step, starting at 1. */
  attempt: number;
  spec: AgentSpec;
  catalogue: Catalogue;
  available: ReadonlyMap<string, AvailableTool>;
  bucket: R2Bucket | undefined;
  logger: Logger;
  /** The Turn's signal; the Step and each call derive their own from it. */
  signal: AbortSignal;
  append(data: ThreadEventData): ThreadEvent;
  /** Logs `approval.requested` for the call and arms its timeout. */
  ask(call: ToolCall): void;
  /** A Connection value by name at one level; the user-level store is not built yet and answers nothing. */
  connection(level: Connection["level"], name: string): Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** How an asked call stands: requested, and answered or not. */
export interface CallApproval {
  request: number;
  answer?: ApprovalAnswer & { source: "answer" | "timeout" | "cancel" };
}

export type JobOutcome = { type: "job.completed"; result: ToolResult } | { type: "job.failed"; message: string } | { type: "job.cancelled" };

/** What the log already holds for this Step's calls, so a re-run neither re-fires Hooks nor re-runs finished work. */
export interface PriorCalls {
  /** Calls with a logged `tool.call`, keyed by tool-call id: their seq (the callId) and effective input. */
  started: ReadonlyMap<string, { seq: number; input: unknown }>;
  /** Calls with a logged `tool.result`. */
  finished: ReadonlySet<string>;
  /** Calls with a logged `approval.requested`, keyed by tool-call id. */
  approvals: ReadonlyMap<string, CallApproval>;
  /** Calls handed to a Job, keyed by tool-call id, with the Job's outcome once it is logged. */
  jobs: ReadonlyMap<string, { jobId: string; outcome?: JobOutcome }>;
}

const INTERRUPTED_TEXT = "This call was interrupted before it reported a result. It may or may not have taken effect; check before repeating it.";

/** Resolves when every call has a result, or with why the Step parks. */
export async function runToolStep(host: ToolStepHost, batch: readonly ToolCall[], prior: PriorCalls): Promise<Extract<PauseReason, "approval" | "job"> | undefined> {
  const pending = batch.filter((call) => !prior.finished.has(call.id));
  const waitsOn = (call: ToolCall): "approval" | "job" | undefined => {
    const job = prior.jobs.get(call.id);
    if (job) return job.outcome ? undefined : "job";
    const approval = prior.approvals.get(call.id);
    if (approval) return approval.answer ? undefined : "approval";
    return !prior.started.has(call.id) && host.available.get(call.name)?.effect === "ask" ? "approval" : undefined;
  };
  const waiting = pending.filter((call) => waitsOn(call) !== undefined);
  const step = new AbortController();
  const stepSignal = AbortSignal.any([host.signal, step.signal]);
  const started = new Set<string>();
  // Each call gets a leaf of the tree, cut when the call is over so nothing it left behind keeps running.
  const run = async (call: ToolCall) => {
    const leaf = new AbortController();
    try {
      if ((await runCall(host, call, prior, AbortSignal.any([stepSignal, leaf.signal]))) === "pending") started.add(call.id);
    } finally {
      leaf.abort();
    }
  };
  let parallel: ToolCall[] = [];
  const flush = async () => {
    const group = parallel;
    parallel = [];
    if (group.length > 0) await Promise.all(group.map(run));
  };
  try {
    for (const call of pending) {
      if (waitsOn(call) !== undefined) continue;
      if (host.available.get(call.name)?.tool.annotations.readOnlyHint) parallel.push(call);
      else {
        await flush();
        await run(call);
      }
    }
    await flush();
  } finally {
    step.abort();
  }
  // Asks are raised only once every allowed call of the batch has run.
  let reason: "approval" | "job" | undefined = started.size > 0 ? "job" : undefined;
  for (const call of waiting) {
    const waits = waitsOn(call)!;
    if (waits === "approval") {
      if (!prior.approvals.has(call.id)) host.ask(call);
      reason = "approval";
    } else reason ??= "job";
  }
  return reason;
}

async function runCall(host: ToolStepHost, call: ToolCall, prior: PriorCalls, signal: AbortSignal): Promise<"pending" | undefined> {
  signal.throwIfAborted();
  const started = prior.started.get(call.id);
  const entry = host.available.get(call.name);
  const annotations = entry?.tool.annotations ?? DEFAULT_ANNOTATIONS;
  // The result is persisted first, so an eviction during a Hook cannot lose finished work; Hooks then observe it.
  const finish = (seq: number | undefined, result: ToolResult, extra: Partial<Pick<Extract<ThreadEventData, { type: "tool.result" }>, "interrupted" | "output">> = {}) => {
    const logged = seq ?? host.append({ type: "tool.call", id: call.id, name: call.name, input: call.input }).seq;
    host.append({ type: "tool.result", id: call.id, name: call.name, content: result.content, isError: result.isError === true, ...extra });
    return afterTool(host, { id: call.id, callId: callId(host, logged), name: call.name, input: started?.input ?? call.input, annotations }, { ...result, ...(extra.interrupted && { interrupted: extra.interrupted }) }, signal).then(() => undefined);
  };

  if (!entry) return finish(started?.seq, error(`Unknown tool "${call.name}".`));
  const { tool } = entry;

  // A Job's outcome is the call's result, whatever the Tool's annotations say about re-running it.
  const job = prior.jobs.get(call.id);
  if (job?.outcome && started) {
    if (job.outcome.type !== "job.completed") return finish(started.seq, error(job.outcome.type === "job.failed" ? `Job failed: ${job.outcome.message}` : "Job cancelled."));
    const spilled = await spill(host, tool, started.seq, job.outcome.result);
    return finish(started.seq, spilled.result, spilled.output ? { output: spilled.output } : {});
  }

  // A re-run may repeat only work that is safe to repeat; anything else gets an honest "interrupted".
  if (started && !(annotations.readOnlyHint || annotations.idempotentHint)) {
    return finish(started.seq, error(INTERRUPTED_TEXT), { interrupted: { attempt: host.attempt } });
  }

  let input = started?.input ?? call.input;
  let seq = started?.seq;
  if (seq === undefined) {
    if (entry.effect === "deny") return finish(undefined, error(`Tool "${call.name}" is denied by the Permission Policy.`));
    const answer = prior.approvals.get(call.id)?.answer;
    if (answer?.decision === "deny") return finish(undefined, error(`Tool "${call.name}" was denied${answer.reason ? `: ${answer.reason}` : answer.source === "timeout" ? ": the approval timed out." : "."}`));
    const decision = await beforeTool(host, { id: call.id, name: call.name, input, annotations }, signal);
    signal.throwIfAborted();
    if (decision.effect === "deny") return finish(undefined, error(`Tool "${call.name}" was refused by a Hook${decision.reason ? `: ${decision.reason}` : "."}`));
    if (decision.input !== undefined) input = decision.input;
    seq = host.append({ type: "tool.call", id: call.id, name: call.name, input }).seq;
  }

  const parsed = z.safeParse(tool.input, input);
  if (!parsed.success) return finish(seq, error(`Invalid input for "${call.name}": ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`));

  const connection = await resolveConnection(host, tool);
  signal.throwIfAborted();
  if (!connection.ok) return finish(seq, error(connection.message));

  const ctx: ToolContext<unknown> = {
    scope: host.scope,
    ...(host.user !== undefined && { user: host.user }),
    thread: { id: host.threadId },
    settings: entry.settings,
    ...(connection.value && { connection: connection.value }),
    attempt: host.attempt,
    callId: callId(host, seq),
    media: { put: (body, opts) => putMedia(host, body, opts) },
    logger: host.logger,
    signal,
  };
  let result: ToolResult;
  try {
    const outcome = normalize(await tool.execute(parsed.data, ctx as never));
    if ("pending" in outcome) {
      host.append({ type: "job.started", id: call.id, jobId: outcome.pending });
      return "pending";
    }
    result = outcome;
  } catch (caught) {
    if (isPlatformFailure(caught)) throw caught;
    result = error(errorMessage(caught));
  }
  const spilled = await spill(host, tool, seq, result);
  return finish(seq, spilled.result, spilled.output ? { output: spilled.output } : {});
}

const callId = (host: ToolStepHost, seq: number) => `${host.threadId}:${seq}`;
const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const errorMessage = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

function normalize(raw: ToolOutcome): ToolResult | { pending: string } {
  return typeof raw === "string" ? { content: [{ type: "text", text: raw }] } : raw;
}

function hookContext(host: ToolStepHost, point: HookContextBase["point"], signal: AbortSignal): HookContextBase {
  return { point, scope: host.scope, ...(host.user !== undefined && { user: host.user }), thread: { id: host.threadId }, agent: host.agent, turn: host.turn, logger: host.logger, signal };
}

// Hooks run in Spec order; a rewrite feeds the next Hook, the first deny wins, and a throwing Hook is a deny.
async function beforeTool(host: ToolStepHost, call: HookToolCall, signal: AbortSignal): Promise<{ effect: "allow"; input?: unknown } | { effect: "deny"; reason?: string }> {
  let input = call.input;
  for (const hook of hooksAt(host.spec, host.catalogue, "before-tool")) {
    try {
      const decision = await hook.run({ ...hookContext(host, "before-tool", signal), call: { ...call, input } });
      if (!decision) continue;
      if (decision.effect === "deny") return decision;
      if (decision.input !== undefined) input = decision.input;
    } catch (caught) {
      if (isPlatformFailure(caught)) throw caught;
      return { effect: "deny", reason: `Hook "${hook.name}" failed: ${errorMessage(caught)}` };
    }
  }
  return input === call.input ? { effect: "allow" } : { effect: "allow", input };
}

async function afterTool(host: ToolStepHost, call: HookToolCall, result: HookContexts["after-tool"]["result"], signal: AbortSignal): Promise<void> {
  for (const hook of hooksAt(host.spec, host.catalogue, "after-tool")) {
    try {
      await hook.run({ ...hookContext(host, "after-tool", signal), call, result });
    } catch (caught) {
      if (isPlatformFailure(caught)) throw caught;
      host.logger.warn(`after-tool Hook "${hook.name}" failed`, { error: errorMessage(caught) });
    }
  }
}

// A name resolves user-level first (the User's own grant, usable across Agents), then agent-level.
// A user-level declaration on a user-less Thread cannot resolve and never becomes a `connect` Approval.
async function resolveConnection(host: ToolStepHost, tool: Tool): Promise<{ ok: true; value?: Connection } | { ok: false; message: string }> {
  if (tool.requires === undefined) return { ok: true };
  const name = tool.requires;
  const declared = host.spec.connections?.[name];
  if (!declared) return { ok: false, message: `Tool "${tool.name}" requires the Connection "${name}", which the Agent does not declare.` };
  const levels: Connection["level"][] = declared.level === "user" ? (host.user === undefined ? [] : ["user"]) : host.user === undefined ? ["agent"] : ["user", "agent"];
  for (const level of levels) {
    const value = await host.connection(level, name);
    if (value !== undefined) return { ok: true, value: { name, type: declared.type, level, value } };
  }
  if (declared.required === false) return { ok: true };
  return { ok: false, message: `Connection "${name}" is not available${declared.level === "user" && host.user === undefined ? " on a user-less Thread" : ""}.` };
}

async function spill(host: ToolStepHost, tool: Tool, seq: number, result: ToolResult): Promise<{ result: ToolResult; output?: MediaRef }> {
  const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const cut = truncateOutput(text, outputLimits(host.spec, tool));
  if (!cut.truncated) return { result };
  let output: MediaRef | undefined;
  if (host.bucket) {
    const key = keys.toolOutput(host.scope, host.threadId, seq);
    const bytes = new TextEncoder().encode(text);
    try {
      await host.bucket.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      output = { id: String(seq), key, mimeType: "text/plain; charset=utf-8", bytes: bytes.byteLength };
    } catch (caught) {
      if (isPlatformFailure(caught)) throw caught;
      host.logger.error("Spilling a Tool output to R2 failed; the full output is lost.", { tool: tool.name, seq, error: errorMessage(caught) });
    }
  } else host.logger.warn("Tool output exceeded the limit but no KARMI_MEDIA bucket is bound; the full output is lost.", { tool: tool.name, seq });
  const content: ToolContent[] = [{ type: "text", text: renderTruncated(cut, output) }, ...result.content.filter((block) => block.type !== "text")];
  return { result: { ...result, content }, ...(output && { output }) };
}

async function putMedia(host: ToolStepHost, body: ReadableStream | ArrayBuffer | string, opts: { mimeType?: string; name?: string } = {}): Promise<MediaRef> {
  if (!host.bucket) throw new Error("ctx.media.put needs the KARMI_MEDIA bucket.");
  const id = crypto.randomUUID();
  const key = keys.media(host.scope, host.threadId, id);
  const mimeType = opts.mimeType ?? (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
  const object = await host.bucket.put(key, body, { httpMetadata: { contentType: mimeType } });
  return { id, key, mimeType, bytes: object.size, ...(opts.name !== undefined && { name: opts.name }) };
}
