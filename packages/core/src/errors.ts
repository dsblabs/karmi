import type { ValidationFailure } from "./validate";

/** Every code karmi throws; a new failure adds its code here first, as `area.camelCase`. */
export type KarmiErrorCode =
  | "agent.conflict"
  | "agent.deleted"
  | "agent.id.invalid"
  | "agent.notFound"
  | "agent.spec.invalid"
  | "approval.invalid"
  | "approval.notFound"
  | "approval.resolved"
  | "bindings.missing"
  | "compaction.failed"
  | "compatibility.date"
  | "config.conflict"
  | "config.invalid"
  | "config.secret-value"
  | "deliverer.invalid"
  | "deliverer.notFound"
  | "destroy.notFound"
  | "job.notFound"
  | "media.id.invalid"
  | "media.tooLarge"
  | "media.typeDenied"
  | "media.urlInvalid"
  | "thread.deleted"
  | "name.duplicate"
  | "name.invalid"
  | "name.reserved"
  | "queue.unhandled"
  | "ref.fragment.unknown"
  | "scope.destroyed"
  | "scope.id.invalid"
  | "scope.suspended"
  | "test.recording-exhausted"
  | "test.recording-miss"
  | "test.script-exhausted"
  | "thread.busy"
  | "thread.exists"
  | "thread.id.invalid"
  | "thread.key.invalid"
  | "thread.mismatch"
  | "thread.notFound"
  | "thread.notParked"
  | "thread.seq.invalid"
  | "user.id.invalid";

/** Every error karmi throws carries a stable, dotted code a caller can switch on. */
export class KarmiError extends Error {
  override readonly name: string = "KarmiError";

  constructor(
    readonly code: KarmiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A rejected Agent Spec, carrying the full validation result so a Platform can render every issue. */
export class SpecInvalidError extends KarmiError {
  override readonly name = "SpecInvalidError";

  constructor(readonly result: ValidationFailure) {
    const errors = result.issues.filter((issue) => issue.severity === "error");
    super(
      "agent.spec.invalid",
      `Agent Spec is invalid: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}

/** The one way to turn a caught value into a message. */
export function errorMessage(caught: unknown): string {
  // eslint-disable-next-line no-restricted-syntax -- the one place this idiom lives.
  return caught instanceof Error ? caught.message : String(caught);
}
