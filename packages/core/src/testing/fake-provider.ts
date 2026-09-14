import { KarmiError } from "../errors";
import type {
  ContentBlock,
  ModelCapabilities,
  Provider,
  ProviderCallOptions,
  ProviderError,
  ProviderEvent,
  ProviderRequest,
  StopReason,
  Usage,
} from "../provider";

// A scripted Provider. It is a real implementation of the Provider seam whose replies a test writes and
// whose requests a test reads back. It is registered under an ordinary Provider profile, so Agent Specs
// need no test-only changes.

/** One piece of a scripted reply, built with the `reply` helpers. */
export type ReplyPart =
  | { part: "text"; chunks: string[] }
  | { part: "reasoning"; chunks: string[] }
  | { part: "toolCall"; id?: string; name: string; input: unknown }
  | { part: "usage"; usage: Partial<Usage> }
  | { part: "raw"; raw: unknown }
  | { part: "error"; error: ProviderError }
  | { part: "stop"; stopReason: StopReason };

/**
 * The answer to one scripted call. A string is a text reply, reply parts are expanded into events, and a
 * `ProviderEvent` array is streamed verbatim.
 */
export type Reply = string | ReplyPart | (ReplyPart | string)[] | ProviderEvent[];

/** What a `ReplyScript` receives for each call. */
export interface ReplyContext {
  request: ProviderRequest;
  /** The 0-based number of this call. */
  index: number;
  /**
   * The call options the Harness passed: the Scope's `fetch`, the Turn's abort signal, attribution and Logger.
   */
  options: ProviderCallOptions;
}

/** A function that answers each call from the request and the call index. */
export type ReplyScript = (ctx: ReplyContext) => Reply | Promise<Reply>;

/** Options for `fakeProvider`. */
export interface FakeProviderOptions {
  /** Overrides for the capabilities reported for every model. By default every modality is supported. */
  capabilities?: Partial<ModelCapabilities>;
  /** Answers `countTokens` requests. Without it the Provider has no `countTokens`. */
  countTokens?: (request: ProviderRequest) => number;
}

/** A scripted Provider that records every request it receives. */
export interface FakeProvider extends Provider {
  /** Every request received, in order, deep-copied at receipt. */
  readonly requests: ProviderRequest[];
  /** Replaces the script and forgets past requests, so one provider can serve many tests. */
  script(next: ReplyScript | Reply[]): void;
}

/**
 * Helpers that build a reply part by part, e.g.
 * `[reply.reasoning("hmm"), reply.text("Sunny"), reply.toolCall("weather", { city })]`.
 */
export const reply = {
  /** A text part, streamed as one `delta` per chunk and then the joined text as a `part`. */
  text: (...chunks: string[]): ReplyPart => ({ part: "text", chunks }),
  /** A thinking part, streamed like `text`. */
  reasoning: (...chunks: string[]): ReplyPart => ({ part: "reasoning", chunks }),
  /**
   * A tool call. Without `id` the call gets `call_<block index>`, which keeps transcripts stable across test
   * order.
   */
  toolCall: (name: string, input: unknown = {}, id?: string): ReplyPart =>
    id === undefined ? { part: "toolCall", name, input } : { part: "toolCall", id, name, input },
  usage: (usage: Partial<Usage>): ReplyPart => ({ part: "usage", usage }),
  raw: (raw: unknown): ReplyPart => ({ part: "raw", raw }),
  /** Ends the stream with an `error` event instead of `message.end`. */
  error: (error: Partial<ProviderError> & Pick<ProviderError, "code">): ReplyPart => ({
    part: "error",
    error: { message: error.code, retryable: false, ...error },
  }),
  /** Overrides the stop reason the fake would infer (`tool_use` with a tool call, `end_turn` otherwise). */
  stop: (stopReason: StopReason): ReplyPart => ({ part: "stop", stopReason }),
};

const DEFAULT_CAPABILITIES: ModelCapabilities = { image: true, audio: true, video: true, pdf: true };
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Creates a scripted Provider. `script` is a function of `{ request, index }` or a list consumed one reply per
 * call. In the list form each element is one call's reply, so a multi-part reply is nested:
 * `[[reply.text("a"), reply.toolCall("w")]]`.
 */
export function fakeProvider(script: ReplyScript | Reply[], options: FakeProviderOptions = {}): FakeProvider {
  const requests: ProviderRequest[] = [];
  let next = toScript(script);
  const capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const provider: FakeProvider = {
    requests,
    script(replacement) {
      next = toScript(replacement);
      requests.length = 0;
    },
    async *stream(request, options) {
      const { signal } = options;
      const index = requests.length;
      requests.push(structuredClone(request));
      const events = toEvents(await next({ request, index, options }), request.model);
      for (const event of events) {
        if (signal.aborted) {
          yield { type: "error", error: { code: "aborted", message: "aborted", retryable: false } };
          return;
        }
        yield event;
      }
    },
    capabilities: () => capabilities,
  };
  if (options.countTokens) {
    const count = options.countTokens;
    provider.countTokens = async (request) => ({ tokens: count(request) });
  }
  return provider;
}

function toScript(script: ReplyScript | Reply[]): ReplyScript {
  if (typeof script === "function") return script;
  return ({ index }) => {
    const reply = script[index];
    if (reply === undefined)
      throw new KarmiError(
        "test.script-exhausted",
        `fakeProvider has ${script.length} scripted replies but received call #${index + 1}.`,
      );
    return reply;
  };
}

function isEventStream(reply: Reply): reply is ProviderEvent[] {
  return Array.isArray(reply) && reply.length > 0 && typeof reply[0] === "object" && "type" in reply[0];
}

/** Expands a scripted reply into the event stream a real adapter would produce. */
export function toEvents(reply: Reply, model: string): ProviderEvent[] {
  if (isEventStream(reply)) return reply;
  const parts = (Array.isArray(reply) ? reply : [reply]).map((part): ReplyPart =>
    typeof part === "string" ? { part: "text", chunks: [part] } : part,
  );

  const events: ProviderEvent[] = [{ type: "message.start", model }];
  let usage: Usage = ZERO_USAGE;
  let stopReason: StopReason = "end_turn";
  let index = 0;
  for (const part of parts) {
    switch (part.part) {
      case "text":
      case "reasoning": {
        const kind = part.part === "text" ? "text" : "thinking";
        for (const text of part.chunks) events.push({ type: "delta", index, kind, text });
        const block: ContentBlock = { type: kind, text: part.chunks.join("") };
        events.push({ type: "part", index: index++, block });
        break;
      }
      case "toolCall": {
        events.push({ type: "delta", index, kind: "tool_input", text: JSON.stringify(part.input) });
        events.push({
          type: "part",
          index,
          block: { type: "tool_call", id: part.id ?? `call_${index}`, name: part.name, input: part.input },
        });
        index++;
        if (stopReason === "end_turn") stopReason = "tool_use";
        break;
      }
      case "usage":
        usage = { ...ZERO_USAGE, ...part.usage };
        break;
      case "raw":
        events.push({ type: "raw", raw: part.raw });
        break;
      case "stop":
        stopReason = part.stopReason;
        break;
      case "error":
        events.push({ type: "error", error: part.error });
        return events;
    }
  }
  events.push({ type: "message.end", stopReason, usage });
  return events;
}
