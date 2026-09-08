import * as z from "zod/mini";
import type { AgentSpec } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import type { Logger, MediaRef } from "./context.js";
import type { HookContextBase, HookToolCall } from "./hook.js";
import { hooksAt } from "./hooks.js";
import { keys } from "./keys.js";
import { renderTruncated, truncateOutput } from "./spill.js";
import type { ThreadEvent, ThreadEventData } from "./thread-events.js";
import type { Connection, Tool, ToolContent, ToolContext, ToolResult } from "./tool.js";
import { outputLimits, type AvailableTool } from "./tools.js";

// One tool Step: the model's tool-call batch run under the Harness gate. Read-only Tools run in
// parallel, anything else alone; every call is logged before it runs and its result as soon as it
// lands, so a re-run after an eviction knows exactly what already happened.

/** What the Step reads from and writes to: the Thread DO, narrowed to what a batch needs. */
export interface ToolStepHost {
  scope: string;
  user?: string;
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
  signal: AbortSignal;
  append(data: ThreadEventData): ThreadEvent;
  /** Agent-level Connection values live in ScopeConfig; the user-level store is not built yet. */
  connection(name: string): Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** What the log already holds for this Step's calls, so a re-run neither re-fires Hooks nor re-runs finished work. */
export interface PriorCalls {
  /** Calls with a logged `tool.call`, keyed by tool-call id: their seq (the callId) and effective input. */
  started: ReadonlyMap<string, { seq: number; input: unknown }>;
  /** Calls with a logged `tool.result`. */
  finished: ReadonlySet<string>;
}

const INTERRUPTED_TEXT = "This call was interrupted before it reported a result. It may or may not have taken effect; check before repeating it.";

export async function runToolStep(host: ToolStepHost, batch: readonly ToolCall[], prior: PriorCalls): Promise<void> {
  const pending = batch.filter((call) => !prior.finished.has(call.id));
  const step = new AbortController();
  const signal = AbortSignal.any([host.signal, step.signal]);
  const run = (call: ToolCall) => runCall(host, call, prior.started.get(call.id), AbortSignal.any([signal]));
  let parallel: ToolCall[] = [];
  const flush = async () => {
    const group = parallel;
    parallel = [];
    if (group.length > 0) await Promise.all(group.map(run));
  };
  try {
    for (const call of pending) {
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
}

async function runCall(host: ToolStepHost, call: ToolCall, started: { seq: number; input: unknown } | undefined, signal: AbortSignal): Promise<void> {
  const entry = host.available.get(call.name);
  const finish = (seq: number | undefined, result: ToolResult, extra: Partial<Pick<Extract<ThreadEventData, { type: "tool.result" }>, "interrupted" | "output">> = {}) => {
    const logged = seq ?? host.append({ type: "tool.call", id: call.id, name: call.name, input: call.input }).seq;
    const hookCall: HookToolCall = { callId: callId(host, logged), name: call.name, input: started?.input ?? call.input, annotations: entry?.tool.annotations ?? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };
    return afterTool(host, hookCall, result, signal).then(() => void host.append({ type: "tool.result", id: call.id, name: call.name, content: result.content, isError: result.isError === true, ...extra }));
  };

  if (!entry) return finish(undefined, error(`Unknown tool "${call.name}".`));
  const { tool } = entry;

  // A re-run may repeat only work that is safe to repeat; anything else gets an honest "interrupted".
  if (started && host.attempt >= 2 && !(tool.annotations.readOnlyHint || tool.annotations.idempotentHint)) {
    return finish(started.seq, error(INTERRUPTED_TEXT), { interrupted: { attempt: host.attempt } });
  }

  let input = started?.input ?? call.input;
  let seq = started?.seq;
  if (!started) {
    if (entry.effect === "deny") return finish(undefined, error(`Tool "${call.name}" is denied by the Permission Policy.`));
    // Approvals park the Step in a later ticket; until then an `ask` cannot be honoured.
    if (entry.effect === "ask") return finish(undefined, error(`Tool "${call.name}" requires approval, which this Agent cannot request yet.`));
    const decision = await beforeTool(host, { callId: call.id, name: call.name, input, annotations: tool.annotations }, signal);
    if (decision.effect === "deny") return finish(undefined, error(`Tool "${call.name}" was refused by a Hook${decision.reason ? `: ${decision.reason}` : "."}`));
    if (decision.input !== undefined) input = decision.input;
    seq = host.append({ type: "tool.call", id: call.id, name: call.name, input }).seq;
  }

  const parsed = z.safeParse(tool.input, input);
  if (!parsed.success) return finish(seq, error(`Invalid input for "${call.name}": ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`));

  const connection = await resolveConnection(host, tool);
  if (!connection.ok) return finish(seq, error(connection.message));

  const id = callId(host, seq!);
  const ctx: ToolContext<unknown> = {
    scope: host.scope,
    ...(host.user !== undefined && { user: host.user }),
    thread: { id: host.threadId },
    settings: entry.settings,
    ...(connection.value && { connection: connection.value }),
    attempt: host.attempt,
    callId: id,
    media: { put: (body, opts) => putMedia(host, body, opts) },
    logger: host.logger,
    signal,
  };
  let result: ToolResult;
  try {
    result = normalize(await tool.execute(parsed.data, ctx as never));
  } catch (caught) {
    result = error(caught instanceof Error ? caught.message : String(caught));
  }
  const spilled = await spill(host, tool, seq!, result);
  return finish(seq, spilled.result, spilled.output ? { output: spilled.output } : {});
}

const callId = (host: ToolStepHost, seq: number) => `${host.threadId}:${seq}`;
const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function normalize(raw: string | ToolResult): ToolResult {
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
      return { effect: "deny", reason: `Hook "${hook.name}" failed: ${caught instanceof Error ? caught.message : String(caught)}` };
    }
  }
  return input === call.input ? { effect: "allow" } : { effect: "allow", input };
}

async function afterTool(host: ToolStepHost, call: HookToolCall, result: ToolResult, signal: AbortSignal): Promise<void> {
  for (const hook of hooksAt(host.spec, host.catalogue, "after-tool")) {
    try {
      await hook.run({ ...hookContext(host, "after-tool", signal), call, result });
    } catch (caught) {
      host.logger.warn(`after-tool Hook "${hook.name}" failed`, { error: caught instanceof Error ? caught.message : String(caught) });
    }
  }
}

async function resolveConnection(host: ToolStepHost, tool: Tool): Promise<{ ok: true; value?: Connection } | { ok: false; message: string }> {
  if (tool.requires === undefined) return { ok: true };
  const declared = host.spec.connections?.[tool.requires];
  if (!declared) return { ok: false, message: `Tool "${tool.name}" requires the Connection "${tool.requires}", which the Agent does not declare.` };
  // User-level resolves first; without a User (or a user-level store) only the agent-level value can answer.
  const value = declared.level === "agent" || host.user !== undefined ? await host.connection(tool.requires) : undefined;
  if (value === undefined) {
    if (declared.required === false) return { ok: true };
    return { ok: false, message: `Connection "${tool.requires}" is not available${host.user === undefined && declared.level === "user" ? " on a user-less Thread" : ""}.` };
  }
  return { ok: true, value: { name: tool.requires, type: declared.type, level: declared.level, value } };
}

async function spill(host: ToolStepHost, tool: Tool, seq: number, result: ToolResult): Promise<{ result: ToolResult; output?: MediaRef }> {
  const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const cut = truncateOutput(text, outputLimits(host.spec, tool));
  if (!cut.truncated) return { result };
  let output: MediaRef | undefined;
  if (host.bucket) {
    const key = keys.toolOutput(host.scope, host.threadId, seq);
    const bytes = new TextEncoder().encode(text);
    await host.bucket.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    output = { id: String(seq), key, mimeType: "text/plain; charset=utf-8", bytes: bytes.byteLength };
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
