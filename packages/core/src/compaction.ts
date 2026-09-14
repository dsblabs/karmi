import type { MediaRef } from "./context";
import type { ContentBlock, Message } from "./provider";
import type { ThreadEvent } from "./thread-events";
import { inputContent } from "./transcript";

// The pure part of Compaction. It computes how full the context is from the last usage report (the log
// is never re-tokenised), where the log may be cut, and what the summary carries forward. The Thread
// Durable Object owns the Step around it.

/** The context bounds one Turn runs under, with every value already resolved. */
export interface ContextLimits {
  /** The model's context window, in tokens. */
  window: number;
  /** The tokens kept free below the window for the next model output. */
  reserveTokens: number;
  /** The tokens of the most recent log a Compaction keeps verbatim. */
  keepRecentTokens: number;
}

/** The context window assumed for a model when neither the Agent Spec, the Scope nor the adapter gives one. */
export const DEFAULT_WINDOW = 200_000;
/** The characters per token assumed when estimating what was logged since the last usage report. */
const CHARS_PER_TOKEN = 4;

/**
 * The context window for a Turn: the Agent Spec's value, else the model's own, else `DEFAULT_WINDOW`.
 * The Scope ceiling caps whichever applies.
 */
export function resolveWindow(sources: { spec?: number; ceiling?: number; model?: number }): number {
  const window = sources.spec ?? sources.model ?? DEFAULT_WINDOW;
  return sources.ceiling === undefined ? window : Math.min(window, sources.ceiling);
}

/** An estimate of the tokens `value` occupies once serialised, from its JSON length. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * The tokens the next model call would carry. It is the last model Step's prompt and output as the
 * provider counted them (or the last Compaction's estimate), plus an estimate of every input and Tool
 * result logged since. `events` is the context log, from the last `thread.compacted` on.
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

/** Whether `tokens` exceeds the window minus the reserve, which is the condition that triggers a Compaction. */
export function overLimit(tokens: number, limits: ContextLimits): boolean {
  return tokens > limits.window - limits.reserveTokens;
}

/** The tokens one logged event adds to the context as the model will see it. */
function eventTokens(event: ThreadEvent): number {
  switch (event.type) {
    case "turn.started":
    case "turn.input":
      return estimateTokens(inputContent(event.input));
    case "tool.result":
      return event.parentCallId ? 0 : estimateTokens(event.content);
    case "message.part":
      return estimateTokens(event.block);
    default:
      return 0;
  }
}

type Boundary = { seq: number; kind: "turn" | "step"; tokensAfter: number };

/**
 * The seq the context restarts from after a Compaction, with the estimated tokens kept. It walks back
 * from the tail to `keepRecentTokens`, then to the start of that Turn. When that Turn would still
 * overflow, the cut falls back to a tool Step boundary that keeps the recent tail, so it never falls
 * inside a call/result batch. When no tail can hold `keepRecentTokens`, the oldest Turn is dropped.
 * `floor` is the previous cut (or 0). Returns undefined when no cut would drop anything beyond it.
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

/** Every seq the context may start from, each with the estimated tokens of what follows it. */
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

/**
 * The media the summarised events carried, oldest first and once each. The summary re-attaches it so
 * the model can still see it.
 */
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
        if (event.parentCallId) break;
        for (const block of event.content) if (block.type === "media") add(block.media);
        break;
      default:
        break;
    }
  }
  return [...refs.values()];
}

/**
 * The messages that stand in for the compacted log. A user message carries the summary (or a framing
 * line) and the attachments. For the `provider` strategy an assistant message replays the provider's
 * compaction block after it.
 */
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

/** The system prompt of the Harness's own summarising model call. */
export const SUMMARY_SYSTEM =
  "You are compacting a conversation between a user and an assistant so it can continue in less space. Write a summary that preserves everything needed to carry on: the user's goals and constraints, decisions taken, facts and identifiers learned, work completed and work still pending, and the current state of any task. Be precise and concrete; keep names, numbers, paths and quoted values exact. Do not add commentary.";

/**
 * The user message of the summarising call. The Agent's own compaction `instructions` are appended when given.
 */
export function summaryInstruction(instructions?: string): string {
  const ask = "Summarise the conversation above.";
  return instructions ? `${ask}\n\n${instructions}` : ask;
}
