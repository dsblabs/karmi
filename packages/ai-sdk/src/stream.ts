import type { LanguageModelV4StreamPart, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import type { ContentBlock, ProviderEvent } from "@karmi/core";
import { toProviderError } from "./errors";
import { usage, stopReason } from "./usage";

type Entry = {
  index: number;
  text: string;
  kind: "text" | "thinking" | "tool_input";
  metadata: SharedV4ProviderMetadata;
};
class Blocks {
  next = 0;
  entries = new Map<string, Entry>();
  completedTools = new Set<string>();
  tools = new Map<string, Extract<ContentBlock, { type: "server_tool" }>>();
  entry(id: string, kind: Entry["kind"] = "text"): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { index: this.next++, text: "", kind, metadata: {} };
      this.entries.set(id, entry);
    }
    return entry;
  }
  part(block: ContentBlock, index = this.next++): ProviderEvent {
    return { type: "part", index, block };
  }
}

export async function* mapStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  model: string,
  provider: string,
  gatewayId?: string,
): AsyncIterable<ProviderEvent> {
  const blocks = new Blocks();
  const reader = stream.getReader();
  let terminal = false;
  try {
    yield { type: "message.start", model };
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      if (part.type === "error") {
        terminal = true;
        yield { type: "error", error: toProviderError(part.error) };
        break;
      }
      if (part.type === "finish") {
        for (const [id, block] of blocks.tools)
          if (!blocks.completedTools.has(id)) yield blocks.part(block, blocks.entry(id).index);
        const measured = usage(part, provider);
        if (gatewayId) measured.gateway = { provider: "cloudflare", id: gatewayId };
        if (blocks.tools.size) measured.serverToolCalls = blocks.tools.size;
        if (part.providerMetadata)
          yield { type: "raw", raw: { type: "provider-metadata", providerMetadata: part.providerMetadata } };
        yield* fallback(part, blocks);
        terminal = true;
        yield {
          type: "message.end",
          stopReason: stopReason(part),
          usage: measured,
          stopDetails: { finishReason: part.finishReason, providerMetadata: part.providerMetadata ?? {} },
        };
        break;
      }
      yield* mapPart(part, blocks);
    }
    if (!terminal)
      yield {
        type: "error",
        error: { code: "network", message: "AI SDK stream ended without a finish part.", retryable: true },
      };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function* mapPart(part: LanguageModelV4StreamPart, blocks: Blocks): Iterable<ProviderEvent> {
  if (part.type === "raw") {
    yield { type: "raw", raw: part.rawValue };
    return;
  }
  if (part.type === "text-start" || part.type === "reasoning-start" || part.type === "tool-input-start") {
    const entry = blocks.entry(
      part.id,
      part.type === "reasoning-start" ? "thinking" : part.type === "tool-input-start" ? "tool_input" : "text",
    );
    mergeMetadata(entry, part.providerMetadata);
    return;
  }
  if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-input-delta") {
    const entry = blocks.entry(part.id);
    mergeMetadata(entry, part.providerMetadata);
    entry.text += part.delta;
    yield { type: "delta", index: entry.index, kind: entry.kind, text: part.delta };
    return;
  }
  if (part.type === "text-end" || part.type === "reasoning-end") {
    const entry = blocks.entry(part.id);
    mergeMetadata(entry, part.providerMetadata);
    yield blocks.part(textBlock(entry), entry.index);
    return;
  }
  if (part.type === "tool-call" || part.type === "tool-result") {
    yield* toolPart(part, blocks);
    return;
  }
  if (part.type === "tool-input-end") {
    mergeMetadata(blocks.entry(part.id), part.providerMetadata);
    return;
  }
  // Unknown families remain observable without pretending they are text or executable Harness tools.
  yield { type: "raw", raw: part };
}

function mergeMetadata(entry: Entry, metadata?: SharedV4ProviderMetadata) {
  for (const [name, value] of Object.entries(metadata ?? {}))
    entry.metadata = { ...entry.metadata, [name]: { ...entry.metadata[name], ...value } };
}

function textBlock(entry: Entry): ContentBlock {
  const meta = Object.keys(entry.metadata).length ? { providerMetadata: entry.metadata } : {};
  if (entry.metadata.anthropic?.type === "compaction")
    return {
      type: "compaction",
      summary: entry.text,
      raw: { type: "text", text: entry.text, providerOptions: entry.metadata },
      ...meta,
    };
  if (entry.kind === "thinking") {
    const signature = entry.metadata.anthropic?.signature;
    return { type: "thinking", text: entry.text, ...(typeof signature === "string" ? { signature } : {}), ...meta };
  }
  return { type: "text", text: entry.text, ...meta };
}

function* toolPart(
  part: Extract<LanguageModelV4StreamPart, { type: "tool-call" | "tool-result" }>,
  blocks: Blocks,
): Iterable<ProviderEvent> {
  const entry = blocks.entry(part.toolCallId, "tool_input");
  mergeMetadata(entry, part.providerMetadata);
  const meta = Object.keys(entry.metadata).length ? { providerMetadata: entry.metadata } : {};
  if (part.type === "tool-call") {
    const input: unknown = JSON.parse(part.input);
    if (!part.providerExecuted) {
      yield blocks.part({ type: "tool_call", id: part.toolCallId, name: part.toolName, input, ...meta }, entry.index);
      return;
    }
    const block: Extract<ContentBlock, { type: "server_tool" }> = {
      type: "server_tool",
      id: part.toolCallId,
      name: part.toolName,
      input,
      ...meta,
    };
    blocks.tools.set(part.toolCallId, block);
  } else {
    const block = blocks.tools.get(part.toolCallId);
    if (!block) throw new TypeError(`Provider result has no call: ${part.toolCallId}`);
    if (part.preliminary) {
      yield { type: "raw", raw: part };
      return;
    }
    blocks.completedTools.add(part.toolCallId);
    yield blocks.part(
      {
        ...block,
        result: { raw: part, summary: typeof part.result === "string" ? part.result : JSON.stringify(part.result) },
      },
      entry.index,
    );
  }
}

function* fallback(
  part: Extract<LanguageModelV4StreamPart, { type: "finish" }>,
  blocks: Blocks,
): Iterable<ProviderEvent> {
  const iterations = part.providerMetadata?.anthropic?.iterations;
  if (!Array.isArray(iterations)) return;
  for (const iteration of iterations) {
    if (
      iteration !== null &&
      typeof iteration === "object" &&
      "type" in iteration &&
      iteration.type === "fallback_message"
    )
      yield blocks.part({ type: "provider", raw: { ...iteration, type: "fallback" } });
  }
}
