import type { ValidationFailure } from "./validate";

/**
 * The stable code of every error karmi throws, named `area.camelCase`. A new failure adds its code here first.
 */
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
  | "credential.conflict"
  | "credential.readOnly"
  | "credential.ref.invalid"
  | "deliverer.invalid"
  | "deliverer.notFound"
  | "destroy.notFound"
  | "knowledge.invalid"
  | "knowledge.indexConflict"
  | "knowledge.inlineLimit"
  | "knowledge.busy"
  | "job.notFound"
  | "mcp.discovery.failed"
  | "mcp.oauth.failed"
  | "mcp.oauth.notOAuth"
  | "mcp.oauth.preRegistrationRequired"
  | "mcp.oauth.state"
  | "mcp.oauth.unconfigured"
  | "mcp.server.unknown"
  | "media.id.invalid"
  | "media.tooLarge"
  | "media.typeDenied"
  | "media.urlInvalid"
  | "thread.deleted"
  | "usage.invalid"
  | "name.duplicate"
  | "name.invalid"
  | "name.reserved"
  | "provider.adapter.unknown"
  | "provider.model.required"
  | "provider.profile.unknown"
  | "queue.unhandled"
  | "schedule.invalid"
  | "schedule.limit"
  | "schedule.notFound"
  | "ref.fragment.unknown"
  | "scope.limit"
  | "scope.destroyed"
  | "scope.id.invalid"
  | "scope.suspended"
  | "secrets.corrupt"
  | "secrets.exposed"
  | "secrets.kek.unknown"
  | "secrets.keyring.invalid"
  | "secrets.unavailable"
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

/** The error every karmi failure is thrown as. It carries a stable, dotted code a caller can switch on. */
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

/** The message of a caught value: the `Error` message, or the value as a string. */
export function errorMessage(caught: unknown): string {
  // eslint-disable-next-line no-restricted-syntax -- every other caller uses this function instead of the idiom.
  return caught instanceof Error ? caught.message : String(caught);
}
