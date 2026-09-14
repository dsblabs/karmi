import type { MediaRef } from "./context";
import type { ContentBlock, StopReason, Usage } from "./provider";
import type { ToolContent, ToolResult } from "./tool";
import type { CredentialUse, FallbackReason } from "./secrets";

// This module defines the Thread's public vocabulary: the Turn inputs that go in and the Thread events that
// come out. Everything is plain JSON. The event log is the only state a Thread has, and every client reads
// the same shape.

/** One piece of a User message: text, or a reference to uploaded media. */
export type Part =
  | { type: "text"; text: string }
  | { type: "image" | "video" | "audio" | "file"; media: MediaRef; mimeType?: string; name?: string };

/**
 * What drives one Turn: a User message or an Event. `channelRef` is opaque and echoed on every event of
 * the Turn. When it carries `{ deliverer: { name, ref } }`, that also sets the Thread's Deliverer.
 */
export type TurnInput =
  /** `skill` names a Skill to activate before the Turn's first model Step, as a User command would. */
  | { kind: "message"; parts: Part[]; skill?: string; channelRef?: unknown }
  | { kind: "event"; type: string; payload: unknown; channelRef?: unknown };

/** The fields every Thread event carries. */
export interface ThreadEventBase {
  /** The event's position in the Thread's log, starting at 1. */
  seq: number;
  /** The Turn the event belongs to. */
  turn: number;
  /** When the event was appended, as epoch milliseconds. */
  at: number;
  /** The `channelRef` of the Turn's input. */
  channelRef?: unknown;
  /** The child Thread and its `seq` when the event was copied up from a Delegation child. */
  child?: { threadId: string; seq: number };
}

/** Why a Turn is parked: an Approval, an exhausted budget, a Job, or a suspended Scope. */
export type PauseReason = "approval" | "budget" | "job" | "scope_suspended";
/**
 * What continued a parked Turn: a steered input, recovery after an eviction, an Approval answer, a Job
 * outcome, or `thread.resume()`.
 */
export type ResumeReason = "input" | "recovered" | "approval" | "job" | "resume";

/**
 * An amount of Steps, active wall time and tokens, either as a limit or as what a Turn has spent since its
 * budget window opened.
 */
export interface Budget {
  /** Model, tool and compact Steps started. */
  steps: number;
  /** Wall time in milliseconds while the Turn is running, excluding time parked. */
  wallMs: number;
  /** Input plus output tokens of completed model Steps. */
  tokens: number;
}

/**
 * What asked for a Compaction: the check before a model Step, a `context_window_exceeded` stop, or
 * `thread.compact()`.
 */
export type CompactionTrigger = "auto" | "overflow" | "manual";
/**
 * What wrote a Compaction summary: the Harness's own model call, the provider's mechanism, or a
 * `before-compact` Hook.
 */
export type CompactionStrategy = "harness" | "provider" | "hook";

/** What ended an Approval: a human answer, its timeout, or the cancel of its Turn. */
export type ApprovalSource = "answer" | "timeout" | "cancel";

/** A human's answer to an Approval, as `thread.approve()` takes it. */
export interface ApprovalAnswer {
  decision: "allow" | "deny";
  /** Free text shown to the model with a deny. */
  reason?: string;
  /** Allows this Tool by name for the rest of the Thread. Ignored on a deny or a `continue`. */
  remember?: boolean;
  /** Who answered. The Framework records it and never authorises it. */
  by?: string;
}

/**
 * How a model call was authenticated: the Provider profile, its credential's source and version, and any
 * fallback taken.
 */
export interface StepCredentials {
  /** The Provider profile the call ran under, after any fallback. */
  profile: string;
  /** The source and version of the credential used. The value itself never enters the log. */
  credential?: CredentialUse;
  /** The profile the call fell back from and why, when it was not the profile's own credential. */
  fallback?: { from: string; reason: FallbackReason };
}

type EventData =
  /** A Usage record for one Script run: its tier and wall time. */
  | { type: "usage.recorded"; kind: "script"; tier: "isolate"; wallMs: number; callId: string }
  /**
   * A Schedule was created on this Thread. It carries the timing as requested, `delay` in milliseconds, and
   * the first firing time.
   */
  | {
      type: "schedule.created";
      scheduleId: string;
      at?: number;
      delay?: number;
      cron?: string;
      tz?: string;
      nextAt: number;
      input: Extract<TurnInput, { kind: "event" }>;
    }
  /**
   * A Schedule fired and its Event is queued as a Turn input. `nextAt` is the cron's next tick, absent for a
   * one-shot.
   */
  | { type: "schedule.fired"; scheduleId: string; nextAt?: number }
  /** A cron tick was dropped because its previous firing is still waiting for a Turn. */
  | { type: "schedule.skipped"; scheduleId: string; nextAt: number }
  | { type: "schedule.cancelled"; scheduleId: string }
  /** A child Thread was opened for the `delegate` call `id`. `childKey` reopens it with `scope.thread()`. */
  | { type: "delegation.started"; id: string; childKey: string }
  /** The child Thread of the `delegate` call `id` finished and `result` is what the parent's model sees. */
  | { type: "delegation.completed"; id: string; childKey: string; result: ToolResult }
  /** A Turn began. `toolsVersion` identifies the set of Tool definitions the Turn runs with. */
  | { type: "turn.started"; input: TurnInput; toolsVersion: string }
  /** A further input of the same Turn, coalesced at Turn start or steered in at a batch boundary. */
  | { type: "turn.input"; input: TurnInput; steer?: boolean }
  /** The Turn ended. `message` is its final assistant content, so a `turn` subscriber needs nothing else. */
  | { type: "turn.completed"; stopReason: StopReason | "budget"; message: ContentBlock[] }
  | { type: "turn.failed"; reason: string; message: string }
  | { type: "turn.paused"; reason: PauseReason }
  | { type: "turn.resumed"; reason: ResumeReason }
  /**
   * A Tool call needs a human's consent. `thread.approve` answers by this event's `seq`. An unanswered
   * request becomes a deny at `timeoutAt`.
   */
  | { type: "approval.requested"; kind: "tool"; id: string; tool: string; input: unknown; timeoutAt: number }
  /** The Turn's budget is exhausted and a human must allow it to continue. */
  | { type: "approval.requested"; kind: "continue"; budget: Budget; timeoutAt: number }
  /** Call `id` needs a Connection to an MCP server. Completing OAuth at `authUrl` answers the request. */
  | {
      type: "approval.requested";
      kind: "connect";
      id: string;
      tool: string;
      serverId: string;
      level: "agent" | "user";
      authUrl: string;
      timeoutAt: number;
    }
  /**
   * An Approval ended. `request` is the `seq` of the `approval.requested` it answers and `tool` names the
   * asked Tool.
   */
  | ({
      type: "approval.resolved";
      request: number;
      kind: "tool" | "continue" | "connect";
      tool?: string;
      source: ApprovalSource;
    } & ApprovalAnswer)
  /** A Tool handed call `id` to a Job. The tool Step waits for the Job's outcome. */
  | { type: "job.started"; id: string; jobId: string }
  | { type: "job.progress"; jobId: string; content: ToolContent[] }
  | { type: "job.completed"; jobId: string; result: ToolResult }
  | { type: "job.failed"; jobId: string; message: string }
  | { type: "job.cancelled"; jobId: string }
  /**
   * A model Step began. `provider` is the adapter serving `model`. Replay keys provider-opaque blocks on it,
   * not on the model id's prefix.
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
  /** A tool Step began. `attempt` counts recovery re-runs of the same tool batch. */
  | { type: "step.started"; kind: "tool"; n: number; attempt: number; agentVersion: number }
  /** A compact Step began: one summarising call by `model`, ending in `thread.compacted`. */
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
   * A Compaction happened. The model context is now the Prompt, `summary` and the events from
   * `firstKeptSeq` on. The log before it stays as it was. `raw` is the provider's own block, replayed
   * byte-exact to the provider named here.
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
   * A Load point. The deferred Tools `names` are in the model's context from here until a Compaction drops
   * this event. A Skill activation names the Skill. `body` is present when no Tool result carries it.
   */
  | { type: "tools.loaded"; names: string[]; skill?: { name: string; body?: string } }
  /**
   * A Tool was called. `input` is what it ran with, after any `before-tool` rewrite. `ctx.callId` is
   * `{threadId}:{seq}` of this event.
   */
  | { type: "tool.call"; id: string; name: string; input: unknown }
  /**
   * A Tool call finished. `output` is the whole result when it was spilled. `interrupted` marks a result the
   * Harness wrote after an eviction.
   */
  | {
      type: "tool.result";
      id: string;
      name: string;
      content: ToolContent[];
      structuredContent?: unknown;
      structuredOutput?: MediaRef;
      isError: boolean;
      interrupted?: { attempt: number };
      output?: MediaRef;
    }
  /** A streamed fragment of the content block at `index`. */
  | { type: "message.delta"; index: number; kind: "text" | "thinking" | "tool_input"; text: string }
  /** The completed content block at `index`. */
  | { type: "message.part"; index: number; block: ContentBlock };

/**
 * The payload of a Thread event without its log position. `parentCallId` marks an event raised by a Script's
 * Tool call under the `run_script` call it belongs to.
 */
export type ThreadEventData = EventData & { parentCallId?: string; child?: { threadId: string; seq: number } };

/** One entry of a Thread's log. */
export type ThreadEvent = ThreadEventBase & ThreadEventData;
/** The `type` of any Thread event. */
export type ThreadEventType = ThreadEventData["type"];

/**
 * How much of a Turn a subscriber or Deliverer receives: `delta` streams tokens, `part` completed blocks,
 * `turn` one message per Turn.
 */
export type Granularity = "delta" | "part" | "turn";
