import type { ScopeId } from "./context.js";
import { assertIdentifier } from "./names.js";

export function assertScopeId(id: string): void {
  assertIdentifier("scope.id.invalid", "ScopeId", id);
}

/** The explicit handle every entry point takes; there is no ambient Scope (ADR-0001). */
export interface Scope {
  readonly id: ScopeId;
}
