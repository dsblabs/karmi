import { mediaUrls, type MediaUrlOptions } from "./media-url";
import { env } from "cloudflare:workers";
import { resolveBindings, type BindingsResolver } from "./bindings";
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
import { layerDeploymentCredentials, type SecretsProvider } from "./secrets";

/** The options `createKarmi` takes to assemble a Deployment. */
export interface KarmiOptions<Env = unknown> {
  /** Everything the Deployment defines in code, for Agent Specs to reference by name. */
  catalogue: CatalogueInput;
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
  /** The two Durable Object classes the Worker re-exports by name. */
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

/**
 * Assembles a Deployment from `options`. Call it at module evaluation so every boot error is a
 * startup error.
 */
export function createKarmi<Env = unknown>(options: KarmiOptions<Env>): Karmi {
  assertCompatibilityBaseline();
  const providers = options.providers ?? {};
  const bindings = resolveBindings(env as Env, options.bindings);
  const store =
    options.secrets ??
    envelopeSecrets({
      scopes: bindings.KARMI_SCOPES,
      ...(bindings.KARMI_KEYRING !== undefined && { keyring: bindings.KARMI_KEYRING }),
    });
  const catalogue = assembleCatalogue(options.catalogue);
  if (catalogue.usageHandler && !bindings.KARMI_QUEUE)
    throw new KarmiError(
      "bindings.missing",
      "A UsageHandler needs KARMI_QUEUE; see @karmi/core/wrangler.baseline.jsonc.",
    );
  const deployment: Deployment = {
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
    queueHandler: queueHandler(deployment, bindings),
    oauth: oauthRoutes(deployment, bindings),
    scope: (id) => openScope(deployment, bindings, id),
  };
}
