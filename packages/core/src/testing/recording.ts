import { KarmiError } from "../errors.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../provider.js";
import { fakeProvider, type FakeProvider, type FakeProviderOptions } from "./fake-provider.js";

// Record a real Provider's streams once, replay them forever: real model behaviour as a regression test.
// Core touches no filesystem; the caller writes `toJSONL()` wherever it keeps fixtures.

export interface RecordingEntry {
  request: ProviderRequest;
  events: ProviderEvent[];
  /** Set when the recorder was given a `key`; lets a replay match by content instead of call order. */
  key?: string;
}

export interface RecordingOptions {
  /** Derives a lookup key from a request, e.g. the last user message's text. */
  key?: (request: ProviderRequest) => string;
}

export interface RecordingProvider extends Provider {
  readonly entries: RecordingEntry[];
  /** One `{ request, events, key? }` object per line. */
  toJSONL(): string;
}

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
  if (real.countTokens) recorder.countTokens = (request, callOptions) => real.countTokens!(request, callOptions);
  return recorder;
}

/**
 * A fakeProvider that answers from a recording: by call order, or — when the recording and the
 * replay share a `key` — by the first unused entry whose key matches the incoming request.
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
    if (at < 0)
      throw new KarmiError("test.recording-miss", `No unused recording entry with key ${JSON.stringify(wanted)}.`);
    used.add(at);
    return entries[at]!.events;
  }, fakeOptions);
}

function parseJSONL(text: string): RecordingEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordingEntry);
}
