import type { AgentSpec } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import type { ScopeId } from "./context.js";
import { KarmiError, SpecInvalidError } from "./errors.js";
import { keys } from "./keys.js";
import { assertIdentifier } from "./names.js";
import type { AgentRecord, AgentSummary, AgentVersion, ConfigRecord, DestroyStatus, Outcome, ScopeConfigDurableObject, ScopeStatus } from "./scope-config-do.js";
import type { ScopeConfigDocument } from "./scope-config.js";
import type { ValidationResult } from "./validate.js";

export type { AgentRecord, AgentSummary, AgentVersion, ConfigRecord, DestroyStatus, ScopeState, ScopeStatus } from "./scope-config-do.js";

export function assertScopeId(id: string): void {
  assertIdentifier("scope.id.invalid", "ScopeId", id);
}

/** The explicit handle every entry point takes; there is no ambient Scope (ADR-0001). */
export interface Scope {
  readonly id: ScopeId;
  readonly config: {
    get(): Promise<ConfigRecord>;
    /** Replaces the whole document as a new revision; `ifRevision` makes it a compare-and-set. */
    set(document: ScopeConfigDocument, options?: { ifRevision?: number }): Promise<{ revision: number }>;
  };
  readonly agents: {
    /** Validates against the Catalogue and this Scope, then stores the next version; `ifVersion: 0` means create-only. */
    put(spec: AgentSpec, options?: { ifVersion?: number }): Promise<{ agentId: string; version: number }>;
    get(agentId: string, options?: { version?: number }): Promise<AgentRecord>;
    list(): Promise<AgentSummary[]>;
    history(agentId: string): Promise<AgentVersion[]>;
    /** Tombstones the Agent; its versions stay readable by number and a later put continues them. */
    delete(agentId: string): Promise<void>;
    /** The same validation `put` runs, without storing anything. */
    validate(spec: AgentSpec): Promise<ValidationResult>;
  };
  status(): Promise<ScopeStatus>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  /** Tombstones the Scope at once; the walk that empties it reports through `destroyStatus`. */
  destroy(): Promise<{ operationId: string }>;
  destroyStatus(operationId: string): Promise<DestroyStatus>;
}

export function openScope(bindings: KarmiBindings, id: ScopeId): Scope {
  assertScopeId(id);
  const stub = bindings.KARMI_SCOPES.get(bindings.KARMI_SCOPES.idFromName(keys.config(id))) as DurableObjectStub<ScopeConfigDurableObject>;
  const call = async <T>(outcome: Promise<Outcome<T>>, agentId?: string): Promise<T> => {
    const result = await outcome;
    if (result.ok) return result.value;
    if (result.result) throw new SpecInvalidError(agentId ?? "?", result.result);
    throw new KarmiError(result.code, result.message);
  };
  return {
    id,
    config: {
      get: () => call(stub.configGet(id)),
      set: (document, options) => call(stub.configSet(id, document, options?.ifRevision)),
    },
    agents: {
      put: (spec, options) => call(stub.agentsPut(id, spec, options?.ifVersion), spec.agentId),
      get: (agentId, options) => call(stub.agentsGet(id, agentId, options?.version)),
      list: () => call(stub.agentsList(id)),
      history: (agentId) => call(stub.agentsHistory(id, agentId)),
      delete: (agentId) => call(stub.agentsDelete(id, agentId)),
      validate: (spec) => call(stub.agentsValidate(id, spec)),
    },
    status: () => call(stub.status(id)),
    suspend: () => call(stub.suspend(id)),
    resume: () => call(stub.resume(id)),
    destroy: () => call(stub.destroy(id)),
    destroyStatus: (operationId) => call(stub.destroyStatus(id, operationId)),
  };
}
