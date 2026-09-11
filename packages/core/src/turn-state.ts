import type { ContentBlock, StopReason } from "./provider.js";
import type { Budget, PauseReason, ThreadEventData } from "./thread-events.js";
import type { CallApproval, JobOutcome, PriorCalls, ToolCall } from "./tool-step.js";

// The Turn as its event log tells it, folded without any I/O so the Thread DO only reads rows and a test
// only needs events. Results, started calls, asks and Jobs are kept across re-runs of the same tool Step
// and dropped only when a new model Step starts a new batch; the budget window reopens at an allowed
// `continue`.

/**
 * What the log says the Turn should do next: re-run or start a model Step, run the tool batch of the
 * last model Step (re-runs carry what already happened), or end with the last model Step's message.
 */
export type Plan =
  | { kind: "model"; n: number; fresh: boolean }
  | { kind: "tool"; n: number; fresh: boolean; batch: ToolCall[]; prior: PriorCalls }
  | { kind: "finish"; stopReason: StopReason; message: ContentBlock[] };

export type Request =
  | { kind: "tool"; id: string; tool: string; timeoutAt: number; answered: boolean }
  | { kind: "continue"; timeoutAt: number; answered: boolean };

type Job = { jobId: string; outcome?: JobOutcome };

/** The Turn as the log tells it: the next Step, what it waits on, and what it has spent. */
export interface TurnState {
  plan: Plan;
  budget: Budget;
  /** Set while the Turn is parked. */
  paused?: PauseReason;
  /** Every `approval.requested` of the current Step, by its seq. */
  requests: Map<number, Request>;
  /** The current tool Step's asks by tool-call id. */
  approvals: Map<string, CallApproval>;
  /** The current tool Step's Jobs by tool-call id. */
  jobs: Map<string, Job>;
  /** The last completed model Step's content, for a Turn that ends without another one. */
  lastMessage: ContentBlock[];
}

export interface LoggedEvent {
  seq: number;
  at: number;
  event: ThreadEventData;
}

/** Folds one Turn's events, `message.delta` excluded, in seq order; `now` closes an open stretch of wall time. */
export function foldTurn(events: Iterable<LoggedEvent>, now: number): TurnState {
  const fold = new TurnFold();
  for (const { seq, at, event } of events) fold.apply(seq, at, event);
  return fold.state(now);
}

type EventOf<T extends ThreadEventData["type"]> = Extract<ThreadEventData, { type: T }>;

class TurnFold {
  private started: { kind: "model" | "tool"; n: number } | undefined;
  private completed = true;
  private steered = false;
  private parts: ContentBlock[] = [];
  private last: { stopReason: StopReason; message: ContentBlock[] } | undefined;
  private readonly calls = new Map<string, { seq: number; input: unknown }>();
  private readonly results = new Set<string>();
  private readonly requests = new Map<number, Request>();
  private readonly approvals = new Map<string, CallApproval>();
  private readonly jobs = new Map<string, Job>();
  private readonly byJob = new Map<string, string>();
  private readonly budget: Budget = { steps: 0, wallMs: 0, tokens: 0 };
  private countedStep = 0;
  /** When the current stretch of active wall time began; unset while parked. */
  private activeSince: number | undefined;
  private paused: PauseReason | undefined;

  apply(seq: number, at: number, event: ThreadEventData): void {
    switch (event.type) {
      case "turn.started":
      case "turn.resumed":
        // A recovery resumes without a pause before it, so its stretch keeps counting from where it began.
        this.activeSince ??= at;
        this.paused = undefined;
        break;
      case "turn.paused":
        if (this.activeSince !== undefined) this.budget.wallMs += at - this.activeSince;
        this.activeSince = undefined;
        this.paused = event.reason;
        break;
      case "turn.input":
        this.steered = true;
        break;
      case "step.started":
        this.stepStarted(event);
        break;
      case "message.part":
        this.parts[event.index] = event.block;
        break;
      case "tool.call":
        this.calls.set(event.id, { seq, input: event.input });
        break;
      case "tool.result":
        this.results.add(event.id);
        break;
      case "step.completed":
        this.stepCompleted(event);
        break;
      case "approval.requested":
        this.approvalRequested(seq, event);
        break;
      case "approval.resolved":
        this.approvalResolved(event);
        break;
      case "job.started":
        this.jobs.set(event.id, { jobId: event.jobId });
        this.byJob.set(event.jobId, event.id);
        break;
      case "job.completed":
      case "job.failed":
      case "job.cancelled":
        this.jobEnded(event);
        break;
      default:
        break;
    }
  }

  state(now: number): TurnState {
    const { budget, requests, approvals, jobs, started, last } = this;
    if (this.activeSince !== undefined) budget.wallMs += now - this.activeSince;
    const prior: PriorCalls = { started: this.calls, finished: this.results, approvals, jobs };
    const batch = (): ToolCall[] =>
      (last?.message ?? []).flatMap((block) =>
        block.type === "tool_call" ? [{ id: block.id, name: block.name, input: block.input }] : [],
      );
    const base = {
      budget,
      requests,
      approvals,
      jobs,
      lastMessage: last?.message ?? [],
      ...(this.paused !== undefined && { paused: this.paused }),
    };
    const plan = (p: Plan): TurnState => ({ ...base, plan: p });
    if (started && !this.completed) {
      if (started.kind === "model") return plan({ kind: "model", n: started.n, fresh: false });
      return plan({ kind: "tool", n: started.n, fresh: false, batch: batch(), prior });
    }
    if (!started || !last) return plan({ kind: "model", n: 1, fresh: true });
    if (started.kind === "tool" || this.steered) return plan({ kind: "model", n: started.n + 1, fresh: true });
    const pending = batch();
    if (pending.length > 0) return plan({ kind: "tool", n: started.n + 1, fresh: true, batch: pending, prior });
    return plan({ kind: "finish", stopReason: last.stopReason, message: last.message });
  }

  private stepStarted(event: EventOf<"step.started">): void {
    this.started = { kind: event.kind, n: event.n };
    this.completed = false;
    this.steered = false;
    this.requests.clear();
    if (event.n > this.countedStep) {
      this.countedStep = event.n;
      this.budget.steps++;
    }
    if (event.kind !== "model") return;
    this.parts = [];
    this.calls.clear();
    this.results.clear();
    this.approvals.clear();
    this.jobs.clear();
    this.byJob.clear();
  }

  private stepCompleted(event: EventOf<"step.completed">): void {
    this.completed = true;
    if (event.kind !== "model") return;
    this.last = { stopReason: event.stopReason, message: this.parts.filter((part) => part !== undefined) };
    this.budget.tokens += event.usage.input + event.usage.output;
  }

  private approvalRequested(seq: number, event: EventOf<"approval.requested">): void {
    if (event.kind !== "tool") {
      this.requests.set(seq, { kind: "continue", timeoutAt: event.timeoutAt, answered: false });
      return;
    }
    this.requests.set(seq, {
      kind: "tool",
      id: event.id,
      tool: event.tool,
      timeoutAt: event.timeoutAt,
      answered: false,
    });
    this.approvals.set(event.id, { request: seq });
  }

  private approvalResolved(event: EventOf<"approval.resolved">): void {
    const request = this.requests.get(event.request);
    if (!request) return;
    request.answered = true;
    if (request.kind === "tool") {
      this.approvals.set(request.id, {
        request: event.request,
        answer: {
          decision: event.decision,
          ...(event.reason !== undefined && { reason: event.reason }),
          source: event.source,
        },
      });
    } else if (event.decision === "allow") {
      this.requests.delete(event.request);
      this.budget.steps = 0;
      this.budget.tokens = 0;
      this.budget.wallMs = 0;
    }
  }

  private jobEnded(event: EventOf<"job.completed" | "job.failed" | "job.cancelled">): void {
    const id = this.byJob.get(event.jobId);
    const job = id === undefined ? undefined : this.jobs.get(id);
    if (job) job.outcome = event;
  }
}
