import { KarmiError } from "./errors.js";
import type { ScopeId } from "./context.js";

const SCOPE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function assertScopeId(id: string): void {
  if (!SCOPE_ID.test(id)) throw new KarmiError("scope.id.invalid", `ScopeId "${id}" must match [A-Za-z0-9_-]{1,64}.`);
}

/** The explicit handle every entry point takes; there is no ambient tenant (ADR-0001). */
export interface Scope {
  readonly id: ScopeId;
}
