import type { AgentSpec } from "./agent.js";
import type { KarmiBindings } from "./bindings.js";
import type { ScopeId } from "./context.js";
import { keys } from "./keys.js";
import { remote, unwrap as call } from "./outcome.js";
import type { AgentRecord, AgentSummary, AgentVersion, ConfigRecord, DestroyStatus, ScopeConfigDurableObject, ScopeStatus } from "./scope-config-do.js";
import type { ScopeConfigDocument } from "./scope-config.js";
import { openThread, type Thread, type ThreadIdentity, type ThreadSummary } from "./thread.js";
import type { ValidationResult } from "./validate.js";

export type { AgentRecord, AgentSummary, AgentVersion, ConfigRecord, DestroyStatus, ScopeState, ScopeStatus } from "./scope-config-do.js";

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
  /** An identity creates the Thread on first use; a key from `thread.key` reopens one and never creates. */
  thread(target: ThreadIdentity | string): Thread;
  readonly threads: {
    /** An Agent's Threads, most recently active first; `user: null` narrows to user-less Threads. */
    list(filter: { agent: string; user?: string | null }): Promise<ThreadSummary[]>;
  };
  status(): Promise<ScopeStatus>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  /** Tombstones the Scope at once; the walk that empties it reports through `destroyStatus`. */
  destroy(): Promise<{ operationId: string }>;
  destroyStatus(operationId: string): Promise<DestroyStatus>;
}

export function openScope(bindings: KarmiBindings, id: ScopeId): Scope {
  // keys.config validates the id; an invalid ScopeId never reaches a Durable Object name.
  const stub = remote<ScopeConfigDurableObject>(bindings.KARMI_SCOPES, keys.config(id));
  return {
    id,
    config: {
      get: () => call(stub.configGet(id)),
      set: (document, options) => call(stub.configSet(id, document, options?.ifRevision)),
    },
    agents: {
      put: (spec, options) => call(stub.agentsPut(id, spec, options?.ifVersion)),
      get: (agentId, options) => call(stub.agentsGet(id, agentId, options?.version)),
      list: () => call(stub.agentsList(id)),
      history: (agentId) => call(stub.agentsHistory(id, agentId)),
      delete: (agentId) => call(stub.agentsDelete(id, agentId)),
      validate: (spec) => call(stub.agentsValidate(id, spec)),
    },
    thread: (target) => openThread(bindings, id, target),
    threads: { list: (filter) => call(stub.threadsList(id, filter.agent, filter.user)) },
    status: () => call(stub.status(id)),
    suspend: () => call(stub.suspend(id)),
    resume: () => call(stub.resume(id)),
    destroy: () => call(stub.destroy(id)),
    destroyStatus: (operationId) => call(stub.destroyStatus(id, operationId)),
  };
}
