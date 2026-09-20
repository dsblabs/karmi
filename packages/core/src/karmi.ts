import type { ContainerDriver } from "./container-types";
import { mediaUrls, type MediaUrlOptions } from "./media-url";
import { env } from "cloudflare:workers";
import { resolveBindings, type BindingsResolver, type KarmiBindings } from "./bindings";
import { assembleCatalogue, type Catalogue, type CatalogueInput } from "./catalogue";
import { wallClock, type Clock } from "./clock";
import { assertCompatibilityBaseline } from "./compat";
import type { Deployment } from "./deployment";
import { makeDurableObjects, type DurableObjects } from "./durable-objects";
import { queueHandler } from "./queue";
import { consoleLogger } from "./logger";
import type { Logger } from "./context";
import { KarmiError } from "./errors";
import type { Provider } from "./provider";
import { parseScopeConfig, type ScopeConfigDocument } from "./scope-config";
import { openScope, type Scope } from "./scope";
import { envelopeSecrets } from "./envelope-secrets";
import type { McpClientIdentity } from "./mcp-auth";
import { oauthRoutes, type OAuthRoutes } from "./mcp-oauth-routes";
import { layerDeploymentCredentials, markInternalStore, type SecretsProvider } from "./secrets";

/** The options `createKarmi` takes to assemble a Deployment. */
export interface KarmiOptions<Env = unknown> {
  /** Everything the Deployment defines in code, for Agent Specs to reference by name. */
  catalogue: CatalogueInput;
  /** The container image configured for KARMI_SANDBOX in Wrangler. */
  sandbox?: { image: string; driver?: (workspaceId: string) => ContainerDriver };
  /** How presigned media URLs are minted. */
  media?: MediaUrlOptions;
  /** The time source. Defaults to wall time. */
  clock?: Clock;
  /**
   * Where structured log lines go. Defaults to one JSON line per call on the Worker console. Every line
   * carries the Scope, Agent, Thread and Turn it concerns, and credentials are redacted before the call.
   */
  logger?: Logger;
  /**
   * The Deployment-wide config layer every Scope inherits and may only tighten. It has the same shape as a
   * Scope config.
   */
  defaults?: ScopeConfigDocument;
  /** The Providers by name. */
  providers?: Record<string, Provider>;
  /** Deployment credentials by name, referenced as `deployment:<name>`. Pass Worker secrets, never literals. */
  credentials?: Record<string, string>;
  /**
   * The Secrets provider that `scope:<name>` credentials live in. Defaults to the envelope store over
   * `KARMI_KEYRING`.
   */
  secrets?: SecretsProvider;
  /** The transport under every outbound Scoped fetch. The Test kit routes it to in-process fakes. */
  fetch?: typeof fetch;
  /**
   * The OAuth client this Deployment presents to MCP servers. Required before any `auth: { type: "oauth" }`
   * server works.
   */
  oauth?: McpClientIdentity;
  /** Maps the Worker's `env` onto karmi's binding names when the Worker cannot use the fixed names. */
  bindings?: BindingsResolver<Env>;
}

/** A running Deployment. The Worker re-exports its Durable Objects and mounts its handlers. */
export interface Karmi {
  /** Mints and verifies presigned media URLs. */
  readonly media: ReturnType<typeof mediaUrls>;
  /** The Durable Object classes the Worker re-exports by name. */
  readonly durableObjects: DurableObjects;
  readonly catalogue: Catalogue;
  /** The queue consumer that runs Deliverers and the UsageHandler. Export it as the Worker's `queue` handler. */
  readonly queueHandler: ExportedHandlerQueueHandler;
  /**
   * The two fixed OAuth routes, the client document and the callback. Mount with
   * `karmi.oauth.handle(request)`.
   */
  readonly oauth: OAuthRoutes;
  /** Opens the Scope with `id`. */
  scope(id: string): Scope;
}

function lazyEnvelopeSecrets(bindings: () => KarmiBindings): SecretsProvider {
  let store: SecretsProvider | undefined;
  const get = () => {
    if (store) return store;
    const resolved = bindings();
    store = envelopeSecrets({
      scopes: resolved.KARMI_SCOPES,
      ...(resolved.KARMI_KEYRING !== undefined && { keyring: resolved.KARMI_KEYRING }),
    });
    return store;
  };
  return markInternalStore({
    resolve: (ref) => get().resolve(ref),
    describe: (ref) => get().describe(ref),
    put: (ref, value) => {
      const current = get();
      const method = current.put;
      if (!method) throw new Error("The default Secrets provider cannot store credentials.");
      return method.call(current, ref, value);
    },
    revoke: (ref) => {
      const current = get();
      const method = current.revoke;
      if (!method) throw new Error("The default Secrets provider cannot revoke credentials.");
      return method.call(current, ref);
    },
    rewrap: (scope) => {
      const current = get();
      const method = current.rewrap;
      if (!method) throw new Error("The default Secrets provider cannot rewrap credentials.");
      return method.call(current, scope);
    },
    list: (scope) => {
      const current = get();
      const method = current.list;
      if (!method) throw new Error("The default Secrets provider cannot list credentials.");
      return method.call(current, scope);
    },
  });
}

/**
 * Assembles a Deployment from `options`. Call it at module evaluation; it reads Worker bindings when an
 * entry point first uses them.
 */
export function createKarmi<Env = unknown>(options: KarmiOptions<Env>): Karmi {
  assertCompatibilityBaseline();
  const providers = options.providers ?? {};
  const catalogue = assembleCatalogue(options.catalogue);
  const bindings = () => {
    const resolved = resolveBindings(env as Env, options.bindings);
    if (catalogue.usageHandler && !resolved.KARMI_QUEUE)
      throw new KarmiError(
        "bindings.missing",
        "A UsageHandler needs KARMI_QUEUE; see @karmi/core/wrangler.baseline.jsonc.",
      );
    return resolved;
  };
  const store = options.secrets ?? lazyEnvelopeSecrets(bindings);
  const deployment: Deployment = {
    ...(options.sandbox && { sandbox: options.sandbox }),
    clock: options.clock ?? wallClock,
    logger: options.logger ?? consoleLogger(),
    catalogue,
    defaults: parseScopeConfig(options.defaults ?? {}, providers),
    providers,
    secrets: layerDeploymentCredentials(options.credentials, store),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    ...(options.oauth && { oauth: options.oauth }),
  };
  const durableObjects = makeDurableObjects(deployment);
  return {
    media: mediaUrls(options.media),
    durableObjects,
    catalogue: deployment.catalogue,
    queueHandler: (batch, runtimeEnv, context) => queueHandler(deployment, bindings())(batch, runtimeEnv, context),
    oauth: oauthRoutes(deployment, bindings),
    scope: (id) => openScope(deployment, bindings(), id),
  };
}
