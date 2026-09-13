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
export { createTestKarmi, type TestKarmi, type TestKarmiOptions, type TestScope, type TestThread } from "./test-karmi";
export {
  fakeMcpServer,
  routeFetch,
  type FakeMcpServer,
  type FakeMcpServerOptions,
  type FakeMcpTool,
  type FakeMcpResult,
  type FakeMcpContent,
  type FakeMcpCall,
  type FakeMcpEra,
} from "./fake-mcp-server";
export type { FakeMcpOAuth, FakeMcpOAuthOptions, FakeAuthorizationRequest, FakeTokenRequest } from "./fake-mcp-oauth";
export { memorySecrets, type MemorySecrets } from "./memory-secrets";
export { matchers, lastMessage, type EventPartial } from "./matchers";

export type { TestClock } from "./clock";
