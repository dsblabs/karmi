import type { MediaRef } from "./context.js";
import type { ContentBlock, Message } from "./provider.js";
import type { ThreadEvent } from "./thread-events.js";
import { inputContent } from "./transcript.js";

// Compaction, the pure part: how full the context is (from the last usage, never re-tokenised), where
// the log may be cut, and what the summary carries forward. The Thread DO owns the Step around it.

/** The context bounds one Turn runs under, every value resolved. */
export interface ContextLimits {
  window: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** What a model is assumed to hold when neither the Spec, the Scope nor the adapter says. */
export const DEFAULT_WINDOW = 200_000;
/** Characters per token, the cheap estimate for what was logged since the last usage report. */
const CHARS_PER_TOKEN = 4;

/** The smallest window anyone declares: the Spec's, the Scope ceiling's or the model's own. */
export function resolveWindow(sources: { spec?: number; ceiling?: number; model?: number }): number {
  const declared = [sources.spec, sources.ceiling, sources.model].filter((value) => value !== undefined);
  return declared.length === 0 ? DEFAULT_WINDOW : Math.min(...declared);
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * How many tokens the next model call would carry: the last model Step's prompt and output as the
 * provider counted them (or the last Compaction's estimate), plus an estimate of every input and Tool
 * result logged since. `events` is the context log: from the last `thread.compacted` on.
 */
export function contextTokens(events: readonly ThreadEvent[]): number {
  let base = 0;
  let since = 0;
  for (const event of events) {
    switch (event.type) {
      case "thread.compacted":
        base = event.tokensAfter;
        since = 0;
        break;
      case "step.completed":
        if (event.kind !== "model") break;
        base = event.usage.input + event.usage.cacheRead + event.usage.cacheWrite + event.usage.output;
        since = 0;
        break;
      default:
        since += eventTokens(event);
    }
  }
  return base + since;
}

export function overLimit(tokens: number, limits: ContextLimits): boolean {
  return tokens > limits.window - limits.reserveTokens;
}

/** What one logged event adds to the context, as the model will see it. */
function eventTokens(event: ThreadEvent): number {
  switch (event.type) {
    case "turn.started":
    case "turn.input":
      return estimateTokens(inputContent(event.input));
    case "tool.result":
      return estimateTokens(event.content);
    case "message.part":
      return estimateTokens(event.block);
    default:
      return 0;
  }
}

type Boundary = { seq: number; kind: "turn" | "step"; tokensAfter: number };

/**
 * Where the log is cut: walk back from the tail to `keepRecentTokens`, then to the start of that Turn.
 * When the Turn that holds the recent tail would still overflow, the cut falls back to a tool Step
 * boundary that keeps the recent tail, so it never lands inside a call/result batch; when no tail can
 * hold `keepRecentTokens`, the oldest Turn goes. `floor` is the previous cut (or 0); a cut that drops
 * nothing beyond it is no cut.
 */
export function chooseCut(
  events: readonly ThreadEvent[],
  limits: ContextLimits,
  floor: number,
): { firstKeptSeq: number; tokensKept: number } | undefined {
  const first = events[0]?.seq ?? 0;
  const boundaries = cutPoints(events).filter((boundary) => boundary.seq > floor && boundary.seq > first);
  const limit = limits.window - limits.reserveTokens;
  const keepsTail = (boundary: Boundary) => boundary.tokensAfter >= limits.keepRecentTokens;
  const turnCut = boundaries.filter((boundary) => boundary.kind === "turn" && keepsTail(boundary)).at(-1);
  const stepCut = boundaries.find((boundary) => keepsTail(boundary) && boundary.tokensAfter <= limit);
  const cut =
    turnCut && turnCut.tokensAfter <= limit
      ? turnCut
      : (stepCut ?? turnCut ?? boundaries.find((boundary) => boundary.kind === "turn"));
  return cut && { firstKeptSeq: cut.seq, tokensKept: cut.tokensAfter };
}

/** Every seq the context may start from, with the estimated size of what follows it. */
function cutPoints(events: readonly ThreadEvent[]): Boundary[] {
  // Walked from the tail, so each boundary sees the size of everything after it.
  const boundaries: Boundary[] = [];
  let after = 0;
  let previous: ThreadEvent | undefined;
  for (const event of events.toReversed()) {
    if (event.type === "step.completed" && event.kind === "tool" && previous)
      boundaries.push({ seq: event.seq + 1, kind: "step", tokensAfter: after });
    after += eventTokens(event);
    if (event.type === "turn.started") boundaries.push({ seq: event.seq, kind: "turn", tokensAfter: after });
    previous = event;
  }
  return boundaries.reverse();
}

/** The media the summarised events carried, oldest first and once each, so the model keeps sight of it. */
export function attachmentsOf(events: readonly ThreadEvent[]): MediaRef[] {
  const refs = new Map<string, MediaRef>();
  const add = (ref: MediaRef) => {
    if (!refs.has(ref.id)) refs.set(ref.id, ref);
  };
  for (const event of events) {
    switch (event.type) {
      case "thread.compacted":
        event.attachments.forEach(add);
        break;
      case "turn.started":
      case "turn.input":
        if (event.input.kind === "message")
          for (const part of event.input.parts) if (part.type !== "text") add(part.media);
        break;
      case "tool.result":
        for (const block of event.content) if (block.type === "media") add(block.media);
        break;
      default:
        break;
    }
  }
  return [...refs.values()];
}

/** How a Compaction reaches the model: a user message with the summary (or a framing line) and the attachments, and, for a provider block, the assistant message that replays it. */
export function summaryMessages(compacted: Extract<ThreadEvent, { type: "thread.compacted" }>): Message[] {
  const attachments: ContentBlock[] = compacted.attachments.map((media) => ({ type: "media", media }));
  if (compacted.strategy !== "provider")
    return [
      {
        role: "user",
        content: [
          { type: "text", text: `Summary of the conversation so far:\n\n${compacted.summary}` },
          ...attachments,
        ],
      },
    ];
  return [
    { role: "user", content: [{ type: "text", text: "The conversation so far was compacted." }, ...attachments] },
    {
      role: "assistant",
      content: [
        compacted.raw === undefined
          ? { type: "compaction", summary: compacted.summary }
          : { type: "compaction", summary: compacted.summary, raw: compacted.raw },
      ],
      provider: compacted.provider,
      model: compacted.model,
      stopReason: "end_turn",
    },
  ];
}

/** The Harness's own summarising call: what it asks for, and what it asks with. */
export const SUMMARY_SYSTEM =
  "You are compacting a conversation between a user and an assistant so it can continue in less space. Write a summary that preserves everything needed to carry on: the user's goals and constraints, decisions taken, facts and identifiers learned, work completed and work still pending, and the current state of any task. Be precise and concrete; keep names, numbers, paths and quoted values exact. Do not add commentary.";

export function summaryInstruction(instructions?: string): string {
  const ask = "Summarise the conversation above.";
  return instructions ? `${ask}\n\n${instructions}` : ask;
}
