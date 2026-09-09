import { fakeProvider as scripted } from "./fake-provider.js";
import { fromRecording } from "./recording.js";

/** A scripted Provider; `fakeProvider.fromRecording(jsonl)` replays a `recordingProvider` capture. */
export const fakeProvider: typeof scripted & { fromRecording: typeof fromRecording } = Object.assign(scripted, { fromRecording });

export { reply, toEvents, type FakeProvider, type FakeProviderOptions, type Reply, type ReplyContext, type ReplyPart, type ReplyScript } from "./fake-provider.js";
export { recordingProvider, fromRecording, type RecordingEntry, type RecordingOptions, type RecordingProvider } from "./recording.js";
export { createTestKarmi, type TestKarmi, type TestScope, type TestThread } from "./test-karmi.js";
export { matchers, lastMessage, type EventPartial } from "./matchers.js";

export type { TestClock } from "./clock.js";
