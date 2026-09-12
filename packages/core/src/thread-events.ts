import type { MediaRef } from "./context";
import type { ContentBlock, StopReason, Usage } from "./provider";
import type { ToolContent, ToolResult } from "./tool";
import type { CredentialUse, FallbackReason } from "./secrets";

// The Thread's outbound vocabulary: Turn inputs going in, Thread events coming out. Everything is plain
// JSON — the event log is the only state a Thread has, and every client reads the same shape.

export type Part =
  | { type: "text"; text: string }
  | { type: "image" | "video" | "audio" | "file"; media: MediaRef; mimeType?: string; name?: string };

/** What drives one Turn: a User message or an Event. `channelRef` is echoed on every event of the Turn; `{ deliverer: { name, ref } }` also sets its offline route. */
export type TurnInput =
  /** `skill` is a User command: that Skill is activated before the Turn's first model Step. */
  | { kind: "message"; parts: Part[]; skill?: string; channelRef?: unknown }
  | { kind: "event"; type: string; payload: unknown; channelRef?: unknown };

export interface ThreadEventBase {
  seq: number;
  turn: number;
  at: number;
  channelRef?: unknown;
}

/** Why a Turn is parked: a human answer, a budget `continue`, a Job, or the Scope. */
export type PauseReason = "approval" | "budget" | "job" | "scope_suspended";
export type ResumeReason = "input" | "recovered" | "approval" | "job" | "resume";

/** Steps, active wall time and tokens: what a Turn may spend, or has spent since its budget window opened. */
export interface Budget {
  steps: number;
  wallMs: number;
  tokens: number;
}

/** What asked for a Compaction: the boundary check, a `context_window_exceeded` stop, or `thread.compact()`. */
export type CompactionTrigger = "auto" | "overflow" | "manual";
/** Who wrote the summary: the Harness's own model call, the provider's mechanism, or a `before-compact` Hook. */
export type CompactionStrategy = "harness" | "provider" | "hook";

/** Who ended an Approval: a human, the clock, or the cancel of its Turn. */
export type ApprovalSource = "answer" | "timeout" | "cancel";

export interface ApprovalAnswer {
  decision: "allow" | "deny";
  reason?: string;
  /** Allow this Tool by name for the rest of the Thread; ignored on a deny or a `continue`. */
  remember?: boolean;
  /** Who answered, recorded and never authorised by the Framework. */
  by?: string;
}

/** How a model call was authenticated: the Provider profile, its credential's source and version, and any fallback taken. */
export interface StepCredentials {
  profile: string;
  credential?: CredentialUse;
  fallback?: { from: string; reason: FallbackReason };
}

export type ThreadEventData =
  | { type: "turn.started"; input: TurnInput; toolsVersion: string }
  /** A further input of the same Turn: coalesced at Turn start, or steered in at a batch boundary. */
  | { type: "turn.input"; input: TurnInput; steer?: boolean }
  /** `message` is the Turn's final assistant content, so a `turn` subscriber needs nothing else. */
  | { type: "turn.completed"; stopReason: StopReason | "budget"; message: ContentBlock[] }
  | { type: "turn.failed"; reason: string; message: string }
  | { type: "turn.paused"; reason: PauseReason }
  | { type: "turn.resumed"; reason: ResumeReason }
  /** Its `seq` is what `thread.approve` answers; `timeoutAt` is when an unanswered request becomes a deny. */
  | { type: "approval.requested"; kind: "tool"; id: string; tool: string; input: unknown; timeoutAt: number }
  | { type: "approval.requested"; kind: "continue"; budget: Budget; timeoutAt: number }
  /** `request` is the seq of the `approval.requested` it answers; `tool` names the asked Tool. */
  | ({
      type: "approval.resolved";
      request: number;
      kind: "tool" | "continue";
      tool?: string;
      source: ApprovalSource;
    } & ApprovalAnswer)
  /** A Tool handed call `id` to a Job; the Step waits for the Job's outcome. */
  | { type: "job.started"; id: string; jobId: string }
  | { type: "job.progress"; jobId: string; content: ToolContent[] }
  | { type: "job.completed"; jobId: string; result: ToolResult }
  | { type: "job.failed"; jobId: string; message: string }
  | { type: "job.cancelled"; jobId: string }
  /**
   * `provider` is the adapter serving `model`; replay keys provider-opaque blocks on it, not on the id's prefix.
   * `credential` says which credential version authenticated the call and `fallback` when it was not the
   * profile's own; the value itself never enters the log.
   */
  | ({
      type: "step.started";
      kind: "model";
      n: number;
      attempt: number;
      model: string;
      provider: string;
      agentVersion: number;
    } & StepCredentials)
  /** `attempt` counts recovery re-runs of the same tool batch. */
  | { type: "step.started"; kind: "tool"; n: number; attempt: number; agentVersion: number }
  /** A compact Step: one summarising call by `model`, ending in `thread.compacted`. */
  | ({
      type: "step.started";
      kind: "compact";
      n: number;
      attempt: number;
      model: string;
      provider: string;
      agentVersion: number;
      trigger: CompactionTrigger;
    } & StepCredentials)
  | { type: "step.completed"; kind: "model"; n: number; stopReason: StopReason; usage: Usage }
  | { type: "step.completed"; kind: "tool" | "compact"; n: number }
  /**
   * The context is now the Prompt, `summary` and the events from `firstKeptSeq` on; the log before it
   * stays as it was. `raw` is the provider's own block, replayed byte-exact to the provider named here.
   */
  | {
      type: "thread.compacted";
      trigger: CompactionTrigger;
      strategy: CompactionStrategy;
      firstKeptSeq: number;
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      raw?: unknown;
      provider: string;
      model: string;
      /** Media the summarised events carried, kept in view of the model. */
      attachments: MediaRef[];
      usage: Usage;
    }
  /**
   * A load point: deferred Tools `names` are in the model's context from here until a Compaction drops
   * this event. A Skill activation names the Skill; `body` is present when no Tool result carries it.
   */
  | { type: "tools.loaded"; names: string[]; skill?: { name: string; body?: string } }
  /** `input` is what the Tool ran with, after any `before-tool` rewrite; `ctx.callId` is `{threadId}:{seq}` of this event. */
  | { type: "tool.call"; id: string; name: string; input: unknown }
  /** `output` is the whole result when it was spilled; `interrupted` marks a Harness-synthesised result after an eviction. */
  | {
      type: "tool.result";
      id: string;
      name: string;
      content: ToolContent[];
      isError: boolean;
      interrupted?: { attempt: number };
      output?: MediaRef;
    }
  | { type: "message.delta"; index: number; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "message.part"; index: number; block: ContentBlock };

export type ThreadEvent = ThreadEventBase & ThreadEventData;
export type ThreadEventType = ThreadEventData["type"];

/** `delta` streams tokens, `part` completed blocks, `turn` one message per Turn. */
export type Granularity = "delta" | "part" | "turn";
