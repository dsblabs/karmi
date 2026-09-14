import type { ContentBlock, Logger, ProviderEvent, StopReason, Usage } from "@karmi/core";
import type {
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

// Maps Anthropic's SSE events to karmi's ProviderEvents. Text, thinking and tool input stream as deltas and
// then complete as `part` events. A server tool waits for its result block so one `part` carries both,
// byte-exact.

/** What `mapStream` needs beyond the events. */
export interface StreamContext {
  /** Receives the log line for a server-side fallback hop. */
  logger?: Logger | undefined;
  /** Whether every SSE event is also emitted as a `raw` event. */
  raw?: boolean | undefined;
  /** The gateway log reference stamped on the final usage. */
  gateway?: Usage["gateway"] | undefined;
}

type Pending = Map<string, { index: number; block: Extract<ContentBlock, { type: "server_tool" }> }>;

type Open =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "tool"; id: string; name: string; json: string; input: unknown }
  | { kind: "server"; id: string; name: string; json: string; input: unknown }
  | { kind: "compaction"; block: Record<string, unknown>; content: string }
  /**
   * Any other block. It is emitted as a `provider` block, or attached to a server tool when it is that tool's
   * result.
   */
  | { kind: "other"; block: Record<string, unknown>; json: string };

const STOP: Record<BetaStopReason, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  max_tokens: "max_tokens",
  tool_use: "tool_use",
  pause_turn: "pause_turn",
  compaction: "pause_turn",
  refusal: "refusal",
  model_context_window_exceeded: "context_window_exceeded",
};

/** Maps the SDK's stream events to ProviderEvents, ending with `message.end` or an `error`. */
export async function* mapStream(
  events: AsyncIterable<BetaRawMessageStreamEvent>,
  context: StreamContext,
): AsyncGenerator<ProviderEvent> {
  const open = new Map<number, Open>();
  const pending: Pending = new Map();
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: StopReason = "end_turn";
  let stopDetails: unknown;
  let ended = false;

  const flush = function* (): Generator<ProviderEvent> {
    for (const { index, block } of pending.values()) yield { type: "part", index, block };
    pending.clear();
  };

  for await (const event of events) {
    if (context.raw) yield { type: "raw", raw: event };
    switch (event.type) {
      case "message_start": {
        const { message } = event;
        usage = mergeUsage(usage, message.usage);
        yield { type: "message.start", model: message.model, responseId: message.id };
        break;
      }
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop":
        yield* blockEvent(event, open, pending, context.logger);
        break;
      case "message_delta": {
        usage = mergeUsage(usage, event.usage);
        if (event.delta.stop_reason) stopReason = STOP[event.delta.stop_reason] ?? "end_turn";
        if (event.delta.stop_details) stopDetails = event.delta.stop_details;
        break;
      }
      case "message_stop": {
        yield* flush();
        ended = true;
        yield {
          type: "message.end",
          stopReason,
          usage: withGateway(usage, context.gateway),
          ...(stopDetails !== undefined && { stopDetails }),
        };
        break;
      }
      default:
        break;
    }
  }
  if (!ended) {
    yield* flush();
    yield {
      type: "error",
      error: { code: "network", message: "The stream ended before message_stop.", retryable: true },
    };
  }
}

type BlockEvent = Extract<
  BetaRawMessageStreamEvent,
  { type: "content_block_start" | "content_block_delta" | "content_block_stop" }
>;

/**
 * Applies one content-block event to the blocks still open and yields the delta or completed part it produces.
 */
function* blockEvent(
  event: BlockEvent,
  open: Map<number, Open>,
  pending: Pending,
  logger: Logger | undefined,
): Generator<ProviderEvent> {
  if (event.type === "content_block_start") {
    open.set(event.index, openBlock(event.content_block, logger));
    return;
  }
  const current = open.get(event.index);
  if (!current) return;
  if (event.type === "content_block_delta") {
    const delta = applyDelta(current, event.delta, event.index);
    if (delta) yield delta;
    return;
  }
  open.delete(event.index);
  const part = close(current, event.index, pending);
  if (part) yield part;
}

function close(current: Open, index: number, pending: Pending): ProviderEvent | undefined {
  switch (current.kind) {
    case "text":
      return { type: "part", index, block: { type: "text", text: current.text } };
    case "thinking":
      return {
        type: "part",
        index,
        block: { type: "thinking", text: current.text, ...(current.signature && { signature: current.signature }) },
      };
    case "tool":
      return {
        type: "part",
        index,
        block: {
          type: "tool_call",
          id: current.id,
          name: current.name,
          input: parseInput(current.json, current.input),
        },
      };
    case "server":
      pending.set(current.id, {
        index,
        block: {
          type: "server_tool",
          id: current.id,
          name: current.name,
          input: parseInput(current.json, current.input),
        },
      });
      return undefined;
    case "compaction":
      return {
        type: "part",
        index,
        block: { type: "compaction", summary: current.content, raw: { ...current.block, content: current.content } },
      };
    case "other":
      return closeOther(current, index, pending);
  }
}

type StartedBlock = Extract<BetaRawMessageStreamEvent, { type: "content_block_start" }>["content_block"];
type BlockDelta = Extract<BetaRawMessageStreamEvent, { type: "content_block_delta" }>["delta"];

function openBlock(block: StartedBlock, logger: Logger | undefined): Open {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "thinking":
      return { kind: "thinking", text: block.thinking, signature: block.signature };
    case "tool_use":
      return { kind: "tool", id: block.id, name: block.name, json: "", input: block.input };
    case "server_tool_use":
      return { kind: "server", id: block.id, name: block.name, json: "", input: block.input };
    case "compaction":
      return { kind: "compaction", block: { ...block }, content: block.content ?? "" };
    default:
      // The served model is on `message_start`. The hop itself is this block, so it is logged once here.
      if (block.type === "fallback")
        logger?.info("provider fallback", { from: block.from.model, to: block.to.model, trigger: block.trigger });
      return { kind: "other", block: { ...block }, json: "" };
  }
}

/**
 * Grows the open block by one delta. Returns the delta event to stream, or undefined for kinds karmi does not
 * stream.
 */
function applyDelta(current: Open, delta: BlockDelta, index: number): ProviderEvent | undefined {
  switch (delta.type) {
    case "text_delta":
      if (current.kind === "text") current.text += delta.text;
      return { type: "delta", index, kind: "text", text: delta.text };
    case "thinking_delta":
      if (current.kind === "thinking") current.text += delta.thinking;
      return { type: "delta", index, kind: "thinking", text: delta.thinking };
    case "signature_delta":
      if (current.kind === "thinking") current.signature += delta.signature;
      return undefined;
    case "input_json_delta":
      if ("json" in current) current.json += delta.partial_json;
      return current.kind === "tool"
        ? { type: "delta", index, kind: "tool_input", text: delta.partial_json }
        : undefined;
    case "compaction_delta":
      if (current.kind === "compaction") current.content += delta.content ?? "";
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Completes a block karmi has no family for: redacted thinking, a server tool's result, or a block replayed
 * verbatim.
 */
function closeOther(current: Extract<Open, { kind: "other" }>, index: number, pending: Pending): ProviderEvent {
  const block = current.json
    ? { ...current.block, input: parseInput(current.json, current.block.input) }
    : current.block;
  if (block.type === "redacted_thinking")
    return {
      type: "part",
      index,
      block: { type: "thinking", text: "", signature: String(block.data), redacted: true },
    };
  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
  const owner = toolUseId === undefined ? undefined : pending.get(toolUseId);
  if (toolUseId === undefined || !owner) return { type: "part", index, block: { type: "provider", raw: block } };
  pending.delete(toolUseId);
  return {
    type: "part",
    index: owner.index,
    block: { ...owner.block, result: { raw: block, summary: summarize(block) } },
  };
}

function parseInput(json: string, fallback: unknown): unknown {
  if (!json) return fallback ?? {};
  try {
    return JSON.parse(json);
  } catch {
    return fallback ?? {};
  }
}

/** A text stand-in for a server-tool result, for models that never saw the original. */
function summarize(block: Record<string, unknown>): string {
  const content = block.content;
  if (Array.isArray(content)) {
    const lines = content.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.title === "string" && typeof entry.url === "string") return [`${entry.title} — ${entry.url}`];
      if (typeof entry.text === "string") return [entry.text];
      if (typeof entry.tool_name === "string") return [`tool: ${entry.tool_name}`];
      return [];
    });
    if (lines.length > 0) return lines.join("\n").slice(0, 4000);
  } else if (typeof content === "string") return content.slice(0, 4000);
  else if (
    typeof content === "object" &&
    content !== null &&
    typeof (content as Record<string, unknown>).error_code === "string"
  )
    return `error: ${(content as Record<string, unknown>).error_code}`;
  return JSON.stringify(content ?? block).slice(0, 4000);
}

function mergeUsage(current: Usage, raw: BetaUsage | BetaMessageDeltaUsage | null | undefined): Usage {
  if (!raw) return current;
  const next: Usage = { ...current };
  if (typeof raw.input_tokens === "number") next.input = raw.input_tokens;
  if (typeof raw.output_tokens === "number") next.output = raw.output_tokens;
  if (typeof raw.cache_read_input_tokens === "number") next.cacheRead = raw.cache_read_input_tokens;
  if (typeof raw.cache_creation_input_tokens === "number") next.cacheWrite = raw.cache_creation_input_tokens;
  if ("cache_creation" in raw && raw.cache_creation) {
    next.cacheWrite = raw.cache_creation.ephemeral_5m_input_tokens + raw.cache_creation.ephemeral_1h_input_tokens;
    next.cacheWrite1h = raw.cache_creation.ephemeral_1h_input_tokens;
  }
  if (raw.output_tokens_details) next.reasoning = raw.output_tokens_details.thinking_tokens;
  if (raw.server_tool_use)
    next.serverToolCalls = raw.server_tool_use.web_search_requests + raw.server_tool_use.web_fetch_requests;
  return next;
}

function withGateway(usage: Usage, gateway: Usage["gateway"] | undefined): Usage {
  return gateway ? { ...usage, gateway } : usage;
}
