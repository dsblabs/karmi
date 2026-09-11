import { fakeProvider as scripted } from "./fake-provider";
import { fromRecording } from "./recording";

/** A scripted Provider; `fakeProvider.fromRecording(jsonl)` replays a `recordingProvider` capture. */
export const fakeProvider: typeof scripted & { fromRecording: typeof fromRecording } = Object.assign(scripted, {
  fromRecording,
});

export {
  reply,
  toEvents,
  type FakeProvider,
  type FakeProviderOptions,
  type Reply,
  type ReplyContext,
  type ReplyPart,
  type ReplyScript,
} from "./fake-provider";
export {
  recordingProvider,
  fromRecording,
  type RecordingEntry,
  type RecordingOptions,
  type RecordingProvider,
} from "./recording";
export { createTestKarmi, type TestKarmi, type TestScope, type TestThread } from "./test-karmi";
export { matchers, lastMessage, type EventPartial } from "./matchers";

export type { TestClock } from "./clock";
