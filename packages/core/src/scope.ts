import type { AgentSpec } from "./agent";
import type { KarmiBindings } from "./bindings";
import type { ScopeId } from "./context";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { remote, unwrap as call } from "./outcome";
import type { ProviderError, ProviderRequest } from "./provider";
import { providerHosts, scopedFetch } from "./scoped-fetch";
import {
  credentialRef,
  resolveProfileCredentials,
  sensitive,
  type CredentialInfo,
  type CredentialUse,
} from "./secrets";
import type {
  AgentRecord,
  AgentSummary,
  AgentVersion,
  ConfigRecord,
  DestroyStatus,
  ScopeConfigDurableObject,
  ScopeStatus,
} from "./scope-config-do";
import { resolveScopeConfig, type ProviderConfig, type ScopeConfigDocument } from "./scope-config";
import { openThread, type Thread, type ThreadIdentity, type ThreadSummary } from "./thread";
import type { ValidationResult } from "./validate";

export type {
  AgentRecord,
  AgentSummary,
  AgentVersion,
  ConfigRecord,
  DestroyStatus,
  ScopeState,
  ScopeStatus,
} from "./scope-config-do";

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
    /** Agent-level Connection values, write-only: a Spec declares them, this sets them, only a Turn reads them. */
    readonly connections: {
      set(agentId: string, name: string, value: unknown): Promise<void>;
      delete(agentId: string, name: string): Promise<void>;
      list(agentId: string): Promise<{ name: string; updatedAt: number }[]>;
    };
  };
  /**
   * Provider credentials of this Scope, referenced from profiles as `scope:<name>`. Write-only: `put`
   * stores a new version and nothing here reads a value back.
   */
  readonly credentials: {
    put(name: string, value: string): Promise<CredentialInfo>;
    describe(name: string): Promise<CredentialInfo | undefined>;
    list(): Promise<(CredentialInfo & { name: string })[]>;
    /** Makes the credential missing at the next model Step; the version keeps counting. */
    revoke(name: string): Promise<void>;
    /** Moves every credential under the active key of the ring; idempotent, run it after a rotation. */
    rewrap(): Promise<{ rewrapped: number }>;
  };
  readonly providers: {
    /** The explicit network check: resolves the profile's credentials and makes one small call. */
    test(profile: string, options?: { model?: string }): Promise<ProviderTest>;
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

/** What `scope.providers.test` found: the call went through, or the Provider's own error. */
export type ProviderTest =
  | { ok: true; profile: string; model: string; credential?: CredentialUse }
  | { ok: false; profile: string; model?: string; error: ProviderError };

export function openScope(deployment: Deployment, bindings: KarmiBindings, id: ScopeId): Scope {
  // keys.config validates the id; an invalid ScopeId never reaches a Durable Object name.
  const stub = remote<ScopeConfigDurableObject>(bindings.KARMI_SCOPES, keys.config(id));
  const { secrets } = deployment;
  const ref = (name: string) => ({ scope: id, ref: credentialRef("scope", name) });
  const readOnly = () =>
    new KarmiError("credential.readOnly", "The configured SecretsProvider does not accept writes from karmi.");
  return {
    id,
    config: {
      get: () => call(stub.configGet(id)),
      set: (document, options) => call(stub.configSet(id, document, options?.ifRevision)),
    },
    credentials: {
      put: (name, value) => (secrets.put ? secrets.put(ref(name), sensitive(value)) : Promise.reject(readOnly())),
      describe: (name) => secrets.describe(ref(name)),
      list: () => (secrets.list ? secrets.list(id) : Promise.resolve([])),
      revoke: (name) => (secrets.revoke ? secrets.revoke(ref(name)) : Promise.reject(readOnly())),
      rewrap: () => (secrets.rewrap ? secrets.rewrap(id) : Promise.resolve({ rewrapped: 0 })),
    },
    providers: {
      test: async (profile, options) => {
        const { document } = await call(stub.configGet(id));
        const config = resolveScopeConfig(deployment.defaults, document).providers?.[profile];
        if (!config)
          throw new KarmiError("provider.profile.unknown", `Provider profile "${profile}" is not configured.`);
        return testProfile(deployment, id, profile, config, options?.model);
      },
    },
    agents: {
      put: (spec, options) => call(stub.agentsPut(id, spec, options?.ifVersion)),
      get: (agentId, options) => call(stub.agentsGet(id, agentId, options?.version)),
      list: () => call(stub.agentsList(id)),
      history: (agentId) => call(stub.agentsHistory(id, agentId)),
      delete: (agentId) => call(stub.agentsDelete(id, agentId)),
      validate: (spec) => call(stub.agentsValidate(id, spec)),
      connections: {
        set: (agentId, name, value) => call(stub.connectionsSet(id, agentId, name, value)),
        delete: (agentId, name) => call(stub.connectionsDelete(id, agentId, name)),
        list: (agentId) => call(stub.connectionsList(id, agentId)),
      },
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

/** One `countTokens` (or a one-token `stream`) under the profile's credentials; the smallest real call the adapter offers. */
async function testProfile(
  deployment: Deployment,
  scope: ScopeId,
  profile: string,
  config: ProviderConfig,
  chosen: string | undefined,
): Promise<ProviderTest> {
  const provider = deployment.providers[config.adapter];
  if (!provider)
    throw new KarmiError("provider.adapter.unknown", `Provider adapter "${config.adapter}" is not registered.`);
  const model = chosen ?? (config.models ?? []).find((glob) => !/[*?[]/.test(glob));
  if (model === undefined)
    throw new KarmiError(
      "provider.model.required",
      `Profile "${profile}" serves only globs; pass { model } to scope.providers.test.`,
    );
  const resolved = await resolveProfileCredentials(deployment.secrets, scope, config);
  if (!resolved.ok)
    return {
      ok: false,
      profile,
      model,
      error: { code: "auth", message: `Credential "${resolved.missing}" is missing.`, retryable: false },
    };
  const native = model.slice(model.indexOf("/") + 1);
  const request: ProviderRequest = {
    model: native,
    config,
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    params: { maxOutputTokens: 1 },
  };
  const hosts = providerHosts(config);
  const options = {
    fetch: scopedFetch({ ...(hosts && { hosts }) }),
    signal: AbortSignal.timeout(30_000),
    credentials: resolved.credentials,
  };
  const failed = (error: ProviderError): ProviderTest => ({ ok: false, profile, model, error });
  const passed = (): ProviderTest => ({ ok: true, profile, model, ...(resolved.use && { credential: resolved.use }) });
  if (provider.countTokens) {
    const counted = await provider.countTokens(request, options);
    return "error" in counted ? failed(counted.error) : passed();
  }
  for await (const event of provider.stream(request, options)) {
    if (event.type === "error") return failed(event.error);
  }
  return passed();
}
