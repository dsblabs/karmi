import type { MediaRef } from "./context.js";
import type { ContentBlock, StopReason, Usage } from "./provider.js";
import type { ToolContent } from "./tool.js";

// The Thread's outbound vocabulary: Turn inputs going in, Thread events coming out. Everything is plain
// JSON — the event log is the only state a Thread has, and every client reads the same shape.

export type Part = { type: "text"; text: string } | { type: "image" | "video" | "audio" | "file"; media: MediaRef; mimeType: string; name?: string };

/** What drives one Turn: a User message or an Event. `channelRef` is opaque and echoed on every event of the Turn. */
export type TurnInput = { kind: "message"; parts: Part[]; channelRef?: unknown } | { kind: "event"; type: string; payload: unknown; channelRef?: unknown };

export interface ThreadEventBase {
  seq: number;
  turn: number;
  at: number;
  channelRef?: unknown;
}

export type ThreadEventData =
  | { type: "turn.started"; input: TurnInput; toolsVersion: string }
  /** `message` is the Turn's final assistant content, so a `turn` subscriber needs nothing else. */
  | { type: "turn.completed"; stopReason: StopReason; message: ContentBlock[] }
  | { type: "turn.failed"; reason: string; message: string }
  | { type: "turn.paused"; reason: "scope_suspended" }
  | { type: "turn.resumed"; reason: "input" | "recovered" }
  /** `provider` is the adapter serving `model`; replay keys provider-opaque blocks on it, not on the id's prefix. */
  | { type: "step.started"; kind: "model"; n: number; attempt: number; model: string; provider: string; agentVersion: number }
  /** `attempt` counts recovery re-runs of the same tool batch. */
  | { type: "step.started"; kind: "tool"; n: number; attempt: number; agentVersion: number }
  | { type: "step.completed"; kind: "model"; n: number; stopReason: StopReason; usage: Usage }
  | { type: "step.completed"; kind: "tool"; n: number }
  /** `input` is what the Tool ran with, after any `before-tool` rewrite; `ctx.callId` is `{threadId}:{seq}` of this event. */
  | { type: "tool.call"; id: string; name: string; input: unknown }
  /** `output` is the whole result when it was spilled; `interrupted` marks a Harness-synthesised result after an eviction. */
  | { type: "tool.result"; id: string; name: string; content: ToolContent[]; isError: boolean; interrupted?: { attempt: number }; output?: MediaRef }
  | { type: "message.delta"; index: number; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "message.part"; index: number; block: ContentBlock };

export type ThreadEvent = ThreadEventBase & ThreadEventData;
export type ThreadEventType = ThreadEventData["type"];

/** `delta` streams tokens, `part` completed blocks, `turn` one message per Turn. */
export type Granularity = "delta" | "part" | "turn";
