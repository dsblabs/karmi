import { KarmiError } from "../errors";
import type { Provider, ProviderEvent, ProviderRequest } from "../provider";
import { fakeProvider, type FakeProvider, type FakeProviderOptions } from "./fake-provider";

// Records a real Provider's streams once so a test can replay real model behaviour.
// Core touches no filesystem. The caller writes `toJSONL()` wherever it keeps fixtures.

/** One recorded Provider call: the request and the events the real Provider streamed back. */
export interface RecordingEntry {
  request: ProviderRequest;
  events: ProviderEvent[];
  /**
   * The lookup key, present when the recorder was given a `key` function. A replay with the same function
   * matches entries by key instead of call order.
   */
  key?: string;
}

/** Options for `recordingProvider` and `fromRecording`. */
export interface RecordingOptions {
  /** Derives a lookup key from a request, e.g. the last user message's text. */
  key?: (request: ProviderRequest) => string;
}

/** A Provider that forwards to a real one and keeps every request with the events it streamed. */
export interface RecordingProvider extends Provider {
  /** Every call recorded so far, in order. */
  readonly entries: RecordingEntry[];
  /** The entries as JSON Lines, one `{ request, events, key? }` object per line. */
  toJSONL(): string;
}

/** Wraps `real` so every call it serves is recorded. The stream itself passes through unchanged. */
export function recordingProvider(real: Provider, options: RecordingOptions = {}): RecordingProvider {
  const entries: RecordingEntry[] = [];
  const recorder: RecordingProvider = {
    entries,
    toJSONL: () => entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
    async *stream(request, callOptions) {
      const entry: RecordingEntry = { request: structuredClone(request), events: [] };
      if (options.key) entry.key = options.key(request);
      entries.push(entry);
      for await (const event of real.stream(request, callOptions)) {
        entry.events.push(structuredClone(event));
        yield event;
      }
    },
    capabilities: (modelId) => real.capabilities(modelId),
  };
  if (real.countTokens) recorder.countTokens = real.countTokens.bind(real);
  return recorder;
}

/**
 * Creates a fakeProvider that answers from a recording. Without `key` the entries are served in call order.
 * With `key`, each call is answered by the first unused entry whose key matches the incoming request.
 */
export function fromRecording(
  recording: string | RecordingEntry[],
  options: RecordingOptions & FakeProviderOptions = {},
): FakeProvider {
  const entries = typeof recording === "string" ? parseJSONL(recording) : recording;
  const { key, ...fakeOptions } = options;
  const used = new Set<number>();
  return fakeProvider(({ request, index }) => {
    if (!key) {
      const entry = entries[index];
      if (!entry)
        throw new KarmiError(
          "test.recording-exhausted",
          `Recording has ${entries.length} entries but received call #${index + 1}.`,
        );
      return entry.events;
    }
    const wanted = key(request);
    const at = entries.findIndex((entry, i) => !used.has(i) && entry.key === wanted);
    const entry = entries[at];
    if (!entry)
      throw new KarmiError("test.recording-miss", `No unused recording entry with key ${JSON.stringify(wanted)}.`);
    used.add(at);
    return entry.events;
  }, fakeOptions);
}

function parseJSONL(text: string): RecordingEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(decodeEntry);
}

/** Decodes one line written by `toJSONL`. The shape is the recorder's own, so it is not validated. */
const decodeEntry = (line: string): RecordingEntry => JSON.parse(line);
