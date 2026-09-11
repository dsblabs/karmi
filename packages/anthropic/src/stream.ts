import type { ContentBlock, Logger, ProviderEvent, StopReason, Usage } from "@karmi/core";
import type {
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

// Anthropic's SSE events → karmi's ProviderEvents. Text, thinking and tool input stream as deltas and
// land as completed `part`s; a server tool waits for its result block so one `part` carries both, byte-exact.

export interface StreamContext {
  logger?: Logger | undefined;
  raw?: boolean | undefined;
  gateway?: Usage["gateway"] | undefined;
}

type Pending = Map<string, { index: number; block: Extract<ContentBlock, { type: "server_tool" }> }>;

type Open =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "tool"; id: string; name: string; json: string; input: unknown }
  | { kind: "server"; id: string; name: string; json: string; input: unknown }
  | { kind: "compaction"; block: Record<string, unknown>; content: string }
  /** Anything else: replayed as `provider`, or attached to a server tool when it is that tool's result. */
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
      case "content_block_start": {
        const block = event.content_block;
        switch (block.type) {
          case "text":
            open.set(event.index, { kind: "text", text: block.text });
            break;
          case "thinking":
            open.set(event.index, { kind: "thinking", text: block.thinking, signature: block.signature });
            break;
          case "tool_use":
            open.set(event.index, { kind: "tool", id: block.id, name: block.name, json: "", input: block.input });
            break;
          case "server_tool_use":
            open.set(event.index, { kind: "server", id: block.id, name: block.name, json: "", input: block.input });
            break;
          case "compaction":
            open.set(event.index, {
              kind: "compaction",
              block: block as unknown as Record<string, unknown>,
              content: block.content ?? "",
            });
            break;
          default:
            // The served model is on `message_start`; the hop itself is this block, logged once.
            if (block.type === "fallback")
              context.logger?.info("provider fallback", {
                from: block.from.model,
                to: block.to.model,
                trigger: block.trigger,
              });
            open.set(event.index, { kind: "other", block: block as unknown as Record<string, unknown>, json: "" });
        }
        break;
      }
      case "content_block_delta": {
        const current = open.get(event.index);
        if (!current) break;
        const { delta } = event;
        switch (delta.type) {
          case "text_delta":
            if (current.kind === "text") current.text += delta.text;
            yield { type: "delta", index: event.index, kind: "text", text: delta.text };
            break;
          case "thinking_delta":
            if (current.kind === "thinking") current.text += delta.thinking;
            yield { type: "delta", index: event.index, kind: "thinking", text: delta.thinking };
            break;
          case "signature_delta":
            if (current.kind === "thinking") current.signature += delta.signature;
            break;
          case "input_json_delta":
            if ("json" in current) current.json += delta.partial_json;
            if (current.kind === "tool")
              yield { type: "delta", index: event.index, kind: "tool_input", text: delta.partial_json };
            break;
          case "compaction_delta":
            if (current.kind === "compaction") current.content += delta.content ?? "";
            break;
          default:
            break;
        }
        break;
      }
      case "content_block_stop": {
        const current = open.get(event.index);
        open.delete(event.index);
        if (!current) break;
        const part = close(current, event.index, pending);
        if (part) yield part;
        break;
      }
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
    case "other": {
      const block = current.json
        ? { ...current.block, input: parseInput(current.json, current.block.input) }
        : current.block;
      if (block.type === "redacted_thinking")
        return {
          type: "part",
          index,
          block: { type: "thinking", text: "", signature: String(block.data), redacted: true },
        };
      const owner = typeof block.tool_use_id === "string" ? pending.get(block.tool_use_id) : undefined;
      if (owner) {
        pending.delete(block.tool_use_id as string);
        return {
          type: "part",
          index: owner.index,
          block: { ...owner.block, result: { raw: block, summary: summarize(block) } },
        };
      }
      return { type: "part", index, block: { type: "provider", raw: block } };
    }
  }
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
