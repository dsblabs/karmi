import { ContainerInput } from "./container-types";
import { scriptValue, storeStructuredResult } from "./script-results";
import { ScriptInput, scriptTools, type ScriptExecution } from "./scripts";
import { ingestToolResult } from "./media-ingress";
import type { ToolOutputResult } from "./tool";
import { putMedia } from "./media";
import type { ScopeConfigDocument } from "./scope-config";
import * as z from "zod/mini";
import type { AgentSpec } from "./agent";
import type { Catalogue } from "./catalogue";
import type { ParentLink } from "./delegation";
import type { Logger, MediaRef, ScopeId, UserId } from "./context";
import type { HookContextBase, HookContexts, HookToolCall } from "./hook";
import { errorMessage } from "./errors";
import { hooksAt } from "./hooks";
import { keys } from "./keys";
import type { Loaded } from "./loading";
import { McpConnectRequired, type ConnectRequest } from "./mcp-source";
import { isPlatformFailure } from "./platform-failure";
import { renderTruncated, truncateOutput } from "./spill";
import type { ApprovalAnswer, ApprovalSource, PauseReason, ThreadEvent, ThreadEventData } from "./thread-events";
import {
  DEFAULT_ANNOTATIONS,
  errorResult,
  type Connection,
  type Tool,
  type ToolAnnotations,
  type ToolContent,
  type ToolContext,
  type ToolOutcome,
  type ToolResult,
} from "./tool";
import { inContext, outputLimits, type AvailableTool } from "./tools";

// One tool Step: the model's tool-call batch run under the Harness gate. Read-only Tools run in
// parallel and anything else runs alone. Every call is logged before it runs and its result is logged
// as soon as it is known, so a re-run after an eviction knows what already happened. A call the Policy
// asks about, or a call a Tool handed to a Job, parks the Step: allowed calls run first, then the Step
// returns the reason it waits and re-runs once the log holds the answers.

/** The Thread Durable Object as one tool Step sees it, narrowed to what a batch reads and writes. */
export interface ToolStepHost {
  /** Receives every result before it is logged. Scripts use it to read a nested call's value. */
  captureResult?(result: ToolResult): void;
  /** The Clock's current time, in epoch milliseconds. */
  now(): number;
  /** The Script sandbox and its limits, present when the `scripts` Capability is granted. */
  scripts?: ScriptExecution;
  /** The `callId` of the `run_script` call this Step runs inside, when it is a nested Script call. */
  parentCallId?: string;
  scope: ScopeId;
  user?: UserId;
  threadId: string;
  agent: string;
  /** The delegating Thread and call, when this Thread is a Delegation child. */
  parent?: ParentLink;
  turn: number;
  /** Recovery attempt of this Step, starting at 1. */
  attempt: number;
  spec: AgentSpec;
  catalogue: Catalogue;
  /** The Step's Tool set by name, denied Tools included. */
  available: ReadonlyMap<string, AvailableTool>;
  /**
   * The Tools and Skills the model's context has loaded. A call to anything else gets an error result and
   * never runs.
   */
  loaded: Loaded;
  /** The bucket spilled outputs are stored in, or undefined when none is bound. */
  bucket: R2Bucket | undefined;
  /** The Scope's media size limits. */
  mediaLimits?: ScopeConfigDocument["media"];
  logger: Logger;
  /** The Turn's abort signal. The Step and each call derive their own from it. */
  signal: AbortSignal;
  append(data: ThreadEventData): ThreadEvent;
  /** Logs `approval.requested` for the call and arms its timeout. */
  ask(call: ToolCall): void;
  /**
   * Starts the consent flow for a missing OAuth grant and logs `approval.requested { kind: "connect" }`. A
   * failure to start becomes the call's error result.
   */
  connect(call: ToolCall, request: ConnectRequest): Promise<{ ok: true } | { ok: false; message: string }>;
  /** The Connection value stored under `name` at one level, the User's or the Agent's, or undefined. */
  connection(level: Connection["level"], name: string): Promise<unknown>;
}

/** One tool call from the model: its id, the Tool name and the raw input. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * The Approval state of one call: the request, whether the Policy or a Connection asked, and the answer
 * once logged.
 */
export interface CallApproval {
  /** The seq of the `approval.requested` event. */
  request: number;
  kind: "tool" | "connect";
  answer?: ApprovalAnswer & { source: ApprovalSource };
}

/** The logged outcome of a Job a call was handed to. */
export type JobOutcome =
  { type: "job.completed"; result: ToolResult } | { type: "job.failed"; message: string } | { type: "job.cancelled" };

/**
 * The calls of this Step the log already records. A re-run reads it so that it neither re-fires Hooks nor
 * repeats finished work.
 */
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

const INTERRUPTED_TEXT =
  "This call was interrupted before it reported a result. It may or may not have taken effect; check before repeating it.";

/**
 * Runs one tool-call batch. Resolves with undefined once every call has a result, or with the reason the
 * Step parks.
 */
export async function runToolStep(
  host: ToolStepHost,
  batch: readonly ToolCall[],
  prior: PriorCalls,
): Promise<Extract<PauseReason, "approval" | "job"> | undefined> {
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
  // Each call gets its own abort controller, aborted when the call is over so nothing it started keeps running.
  const connects = new Set<string>();
  const run = async (call: ToolCall) => {
    const leaf = new AbortController();
    try {
      const ran = await runCall(host, call, prior, AbortSignal.any([stepSignal, leaf.signal]));
      if (ran === "pending") started.add(call.id);
      else if (ran === "connect") connects.add(call.id);
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
      if (containerWaits(host, call, started, waiting, waitsOn)) continue;
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
  let reason: "approval" | "job" | undefined = connects.size > 0 ? "approval" : started.size > 0 ? "job" : undefined;
  for (const call of waiting) {
    const waits = waitsOn(call);
    if (waits === "approval") {
      if (!prior.approvals.has(call.id)) host.ask(call);
      reason = "approval";
    } else if (waits === "job") reason ??= "job";
  }
  return reason;
}

type ResultExtra = Partial<Pick<Extract<ThreadEventData, { type: "tool.result" }>, "interrupted" | "output">>;
type Finish = (seq: number | undefined, result: ToolResult, extra?: ResultExtra) => Promise<undefined>;

async function runCall(
  host: ToolStepHost,
  call: ToolCall,
  prior: PriorCalls,
  signal: AbortSignal,
): Promise<"pending" | "connect" | undefined> {
  signal.throwIfAborted();
  const started = prior.started.get(call.id);
  const entry = host.available.get(call.name);
  const annotations = entry?.tool.annotations ?? DEFAULT_ANNOTATIONS;
  const finish = finisher(host, call, started?.input ?? call.input, annotations, signal);
  if (!entry) return finish(started?.seq, errorResult(`Unknown tool "${call.name}".`));
  if (!inContext(entry, host.loaded)) return finish(started?.seq, errorResult(notLoaded(entry)));

  // A Job's outcome is the call's result, whatever the Tool's annotations say about re-running it.
  const job = prior.jobs.get(call.id);
  if (job?.outcome && started) return finishJob(host, entry.tool, started.seq, job.outcome, finish);

  // A call parked for a Connection never reached the server: an allow retries it once, anything else refuses it.
  const approval = prior.approvals.get(call.id);
  if (started && approval?.kind === "connect") {
    if (approval.answer?.decision !== "allow")
      return finish(started.seq, errorResult(notGranted(call, approval.answer)));
    return execute(host, call, entry, started.input, started.seq, signal, finish, true);
  }

  // A re-run may repeat only work that is safe to repeat. Any other started call gets an interrupted result.
  if (started && !(annotations.readOnlyHint || annotations.idempotentHint)) {
    return finish(started.seq, errorResult(INTERRUPTED_TEXT), { interrupted: { attempt: host.attempt } });
  }

  let input = started?.input ?? call.input;
  let seq = started?.seq;
  if (seq === undefined) {
    const admitted = await admit(host, call, entry, prior.approvals.get(call.id)?.answer, input, signal);
    if (!admitted.ok) return finish(undefined, admitted.result);
    input = admitted.input;
    seq = host.append({ type: "tool.call", id: call.id, name: call.name, input }).seq;
  }
  return execute(host, call, entry, input, seq, signal, finish);
}

// The result is persisted first, so an eviction during a Hook cannot lose finished work; Hooks then observe it.
function finisher(
  host: ToolStepHost,
  call: ToolCall,
  input: unknown,
  annotations: ToolAnnotations,
  signal: AbortSignal,
): Finish {
  return async (seq, result, extra = {}) => {
    const logged = seq ?? host.append({ type: "tool.call", id: call.id, name: call.name, input: call.input }).seq;
    host.captureResult?.(result);
    const structured = await storeStructuredResult(
      host,
      logged,
      result,
      outputLimits(host.spec, host.available.get(call.name)?.tool ?? {}),
    );
    host.append({
      type: "tool.result",
      id: call.id,
      name: call.name,
      content: result.content,
      isError: result.isError === true,
      ...structured,
      ...extra,
    });
    await afterTool(
      host,
      { id: call.id, callId: callId(host, logged), name: call.name, input, annotations },
      { ...result, ...(extra.interrupted && { interrupted: extra.interrupted }) },
      signal,
    );
    return undefined;
  };
}

async function finishJob(host: ToolStepHost, tool: Tool, seq: number, outcome: JobOutcome, finish: Finish) {
  if (outcome.type !== "job.completed")
    return finish(
      seq,
      errorResult(outcome.type === "job.failed" ? `Job failed: ${outcome.message}` : "Job cancelled."),
    );
  const spilled = await spill(host, tool, seq, outcome.result);
  return finish(seq, spilled.result, spilled.output ? { output: spilled.output } : {});
}

/**
 * Admits a call before it first runs: the Policy, then a human's answer, then the before-tool Hooks, which
 * may rewrite the input. Returns the input to run with, or the error result to log instead.
 */
async function admit(
  host: ToolStepHost,
  call: ToolCall,
  entry: AvailableTool,
  answer: CallApproval["answer"],
  input: unknown,
  signal: AbortSignal,
): Promise<{ ok: true; input: unknown } | { ok: false; result: ToolResult }> {
  const refuse = (text: string) => ({ ok: false as const, result: errorResult(text) });
  if (entry.effect === "deny") return refuse(`Tool "${call.name}" is denied by the Permission Policy.`);
  if (answer?.decision === "deny") {
    const why = answer.reason ? `: ${answer.reason}` : answer.source === "timeout" ? ": the approval timed out." : ".";
    return refuse(`Tool "${call.name}" was denied${why}`);
  }
  const annotations = entry.tool.annotations;
  const decision = await beforeTool(host, { id: call.id, name: call.name, input, annotations }, signal);
  signal.throwIfAborted();
  if (decision.effect === "deny")
    return refuse(`Tool "${call.name}" was refused by a Hook${decision.reason ? `: ${decision.reason}` : "."}`);
  return { ok: true, input: decision.input !== undefined ? decision.input : input };
}

async function execute(
  host: ToolStepHost,
  call: ToolCall,
  entry: AvailableTool,
  input: unknown,
  seq: number,
  signal: AbortSignal,
  finish: Finish,
  retry = false,
): Promise<"pending" | "connect" | undefined> {
  const { tool } = entry;
  const parsed = z.safeParse(tool.input, input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    return finish(seq, errorResult(`Invalid input for "${call.name}": ${issues.join("; ")}`));
  }
  const connection = await resolveConnection(host, tool);
  signal.throwIfAborted();
  if (!connection.ok) return finish(seq, errorResult(connection.message));

  const ctx: ToolContext<unknown> = {
    scope: host.scope,
    ...(host.user !== undefined && { user: host.user }),
    thread: { id: host.threadId },
    settings: entry.settings,
    ...(connection.value && { connection: connection.value }),
    attempt: host.attempt,
    callId: callId(host, seq),
    media: {
      put: (body, opts) =>
        putMedia(
          { bucket: host.bucket, scope: host.scope, threadId: host.threadId, limits: host.mediaLimits, signal },
          body,
          opts,
        ),
    },
    logger: host.logger,
    signal,
  };
  let result: ToolResult;
  try {
    const outcome = normalize(await executeOutcome(host, call, parsed.data, ctx, tool));
    if ("pending" in outcome) {
      if (host.parentCallId) return finish(seq, errorResult("Scripts cannot wait for Jobs."));
      host.append({ type: "job.started", id: call.id, jobId: outcome.pending });
      return "pending";
    }
    result = await ingestToolResult(outcome, ctx.media);
  } catch (caught) {
    if (isPlatformFailure(caught)) throw caught;
    if (caught instanceof McpConnectRequired) {
      if (retry || host.parentCallId) return finish(seq, errorResult(notGranted(call)));
      const started = await host.connect(call, caught.request);
      if (started.ok) return "connect";
      result = errorResult(started.message);
    } else result = errorResult(errorMessage(caught));
  }
  host.captureResult?.(result);
  const spilled = await spill(host, tool, seq, result);
  return finish(seq, spilled.result, spilled.output ? { output: spilled.output } : {});
}

const callId = (host: ToolStepHost, seq: number) => keys.toolCall(host.threadId, seq);
const notLoaded = ({ tool, skill }: AvailableTool): string =>
  skill === undefined
    ? `Tool "${tool.name}" is not loaded. Load it with tool_search (select:${tool.name}) before calling it.`
    : `Tool "${tool.name}" belongs to the skill "${skill}", which is not active. Activate it with use_skill first.`;
const notGranted = (call: ToolCall, answer?: CallApproval["answer"]): string =>
  `Tool "${call.name}": connection not granted${answer?.source === "timeout" ? " (the request timed out)" : answer?.reason ? ` (${answer.reason})` : ""}.`;

function normalize(raw: ToolOutcome): ToolOutputResult | { pending: string } {
  return typeof raw === "string" ? { content: [{ type: "text", text: raw }] } : raw;
}

function hookContext(host: ToolStepHost, point: HookContextBase["point"], signal: AbortSignal): HookContextBase {
  return {
    point,
    scope: host.scope,
    ...(host.user !== undefined && { user: host.user }),
    thread: { id: host.threadId },
    agent: host.agent,
    turn: host.turn,
    logger: host.logger,
    signal,
  };
}

// Hooks run in Spec order; a rewrite feeds the next Hook, the first deny wins, and a throwing Hook is a deny.
async function beforeTool(
  host: ToolStepHost,
  call: HookToolCall,
  signal: AbortSignal,
): Promise<{ effect: "allow"; input?: unknown } | { effect: "deny"; reason?: string }> {
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

async function afterTool(
  host: ToolStepHost,
  call: HookToolCall,
  result: HookContexts["after-tool"]["result"],
  signal: AbortSignal,
): Promise<void> {
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
async function resolveConnection(
  host: ToolStepHost,
  tool: Tool,
): Promise<{ ok: true; value?: Connection } | { ok: false; message: string }> {
  if (tool.requires === undefined) return { ok: true };
  const name = tool.requires;
  const declared = host.spec.connections?.[name];
  if (!declared)
    return {
      ok: false,
      message: `Tool "${tool.name}" requires the Connection "${name}", which the Agent does not declare.`,
    };
  const levels: Connection["level"][] =
    declared.level === "user"
      ? host.user === undefined
        ? []
        : ["user"]
      : host.user === undefined
        ? ["agent"]
        : ["user", "agent"];
  for (const level of levels) {
    const value = await host.connection(level, name);
    if (value !== undefined) return { ok: true, value: { name, type: declared.type, level, value } };
  }
  if (declared.required === false) return { ok: true };
  return {
    ok: false,
    message: `Connection "${name}" is not available${declared.level === "user" && host.user === undefined ? " on a user-less Thread" : ""}.`,
  };
}

async function spill(
  host: ToolStepHost,
  tool: Tool,
  seq: number,
  result: ToolResult,
): Promise<{ result: ToolResult; output?: MediaRef }> {
  host.signal.throwIfAborted();
  const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const cut = truncateOutput(text, outputLimits(host.spec, tool));
  if (!cut.truncated) return { result };
  let output: MediaRef | undefined;
  if (host.bucket) {
    const key = keys.toolOutput(host.scope, host.threadId, seq);
    const bytes = new TextEncoder().encode(text);
    try {
      await host.bucket.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      if (host.signal.aborted) {
        await host.bucket.delete(key);
        host.signal.throwIfAborted();
      }
      output = { id: String(seq), key, mimeType: "text/plain; charset=utf-8", bytes: bytes.byteLength };
    } catch (caught) {
      if (isPlatformFailure(caught)) throw caught;
      host.logger.error("Spilling a Tool output to R2 failed; the full output is lost.", {
        tool: tool.name,
        seq,
        error: errorMessage(caught),
      });
    }
  } else
    host.logger.warn("Tool output exceeded the limit but no KARMI_MEDIA bucket is bound; the full output is lost.", {
      tool: tool.name,
      seq,
    });
  const content: ToolContent[] = [
    { type: "text", text: renderTruncated(cut, output) },
    ...result.content.filter((block) => block.type !== "text"),
  ];
  return { result: { ...result, content }, ...(output && { output }) };
}

async function executeScript(host: ToolStepHost, input: unknown, ctx: ToolContext<unknown>): Promise<ToolOutcome> {
  const execution = host.scripts;
  if (!execution) return errorResult("Scripts are unavailable.");
  const available = scriptTools(host.spec, host.available, host.user);
  const container = host.spec.capabilities?.scripts?.tier === "container" ? z.parse(ContainerInput, input) : undefined;
  const code = container?.code ?? z.parse(ScriptInput, input).code;
  const startedAt = host.now();
  const result = await execution.sandbox.run({
    callId: ctx.callId,
    ...(container && { container }),
    code,
    limits: execution.limits,
    signal: ctx.signal,
    tools: [...available.keys()],
    result: execution.result,
    call: scriptCaller(host, ctx, available),
  });
  host.append({
    type: "usage.recorded",
    kind: "script",
    scope: host.scope,
    agent: host.agent,
    ...(host.user !== undefined && { user: host.user }),
    threadId: host.threadId,
    ...(host.parent && { parent: host.parent }),
    tier: host.spec.capabilities?.scripts?.tier ?? "isolate",
    wallMs: host.now() - startedAt,
    callId: ctx.callId,
  });
  if ("pending" in result) return result;
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.error !== undefined };
}

async function executeOutcome(
  host: ToolStepHost,
  call: ToolCall,
  input: unknown,
  ctx: ToolContext<unknown>,
  tool: Tool,
): Promise<ToolOutcome> {
  return call.name === "run_script" && host.scripts ? executeScript(host, input, ctx) : tool.execute(input, ctx);
}

function scriptCaller(host: ToolStepHost, ctx: ToolContext<unknown>, available: ReadonlyMap<string, AvailableTool>) {
  let count = 0;
  return async (name: string, input: unknown, signal: AbortSignal) => {
    const id = keys.scriptCall(ctx.callId, ++count);
    let callId = id;
    let value: unknown;
    let isError = true;
    let captured = false;
    const child: ToolStepHost = {
      ...host,
      available,
      parentCallId: ctx.callId,
      captureResult: (result) => {
        if (!captured) {
          value = scriptValue(result);
          isError = result.isError === true;
          captured = true;
        }
      },
      signal,
      append: (data) => {
        signal.throwIfAborted();
        const event = host.append({ ...data, parentCallId: ctx.callId });
        if (event.type === "tool.call") callId = keys.toolCall(host.threadId, event.seq);
        return event;
      },
    };
    const leaf = new AbortController();
    try {
      await runCall(
        child,
        { id, name, input },
        { started: new Map(), finished: new Set(), approvals: new Map(), jobs: new Map() },
        AbortSignal.any([signal, leaf.signal]),
      );
    } finally {
      leaf.abort();
    }
    return { callId, value, isError };
  };
}

function containerWaits(
  host: ToolStepHost,
  call: ToolCall,
  started: Set<string>,
  waiting: ToolCall[],
  waitsOn: (call: ToolCall) => string | undefined,
): boolean {
  return (
    host.spec.capabilities?.scripts?.tier === "container" &&
    call.name === "run_script" &&
    (started.size > 0 || waiting.some((item) => item.name === "run_script" && waitsOn(item) === "job"))
  );
}
