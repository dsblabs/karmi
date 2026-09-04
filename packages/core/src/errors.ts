import type { ValidationResult } from "./validate.js";

/** Every error karmi throws carries a stable, dotted code a caller can switch on. */
export class KarmiError extends Error {
  override readonly name: string = "KarmiError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A rejected Agent Spec, carrying the full validation result so a Platform can render every issue. */
export class SpecInvalidError extends KarmiError {
  override readonly name = "SpecInvalidError";

  constructor(readonly result: ValidationResult) {
    const errors = result.issues.filter((issue) => issue.severity === "error");
    super("agent.spec.invalid", `Agent Spec is invalid: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
}
