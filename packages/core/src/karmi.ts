import { mediaUrls, type MediaUrlOptions } from "./media-url";
import { env } from "cloudflare:workers";
import { resolveBindings, type BindingsResolver } from "./bindings";
import { assembleCatalogue, type Catalogue, type CatalogueInput } from "./catalogue";
import { wallClock, type Clock } from "./clock";
import { assertCompatibilityBaseline } from "./compat";
import type { Deployment } from "./deployment";
import { makeDurableObjects, type DurableObjects } from "./durable-objects";
import { deliveryQueueHandler } from "./delivery-queue";
import type { Provider } from "./provider";
import { parseScopeConfig, type ScopeConfigDocument } from "./scope-config";
import { openScope, type Scope } from "./scope";
import { envelopeSecrets } from "./envelope-secrets";
import { layerDeploymentCredentials, type SecretsProvider } from "./secrets";

export interface KarmiOptions<Env = unknown> {
  catalogue: CatalogueInput;
  media?: MediaUrlOptions;
  clock?: Clock;
  /** Deployment-wide layer every Scope inherits and may only tighten: the same shape as a Scope config. */
  defaults?: ScopeConfigDocument;
  providers?: Record<string, Provider>;
  /** Deployment credentials by name, referenced as `deployment:<name>`; pass Worker secrets, never literals. */
  credentials?: Record<string, string>;
  /** Where `scope:<name>` credentials live; the envelope store over `KARMI_KEYRING` unless a Platform brings its own. */
  secrets?: SecretsProvider;
  /** The transport under every outbound `scopedFetch`; the test kit routes it to in-process fakes. */
  fetch?: typeof fetch;
  bindings?: BindingsResolver<Env>;
}

export interface Karmi {
  readonly media: ReturnType<typeof mediaUrls>;
  readonly durableObjects: DurableObjects;
  readonly catalogue: Catalogue;
  readonly queueHandler: ExportedHandlerQueueHandler;
  scope(id: string): Scope;
}

/** Assembles a Deployment: runs at module evaluation, so every boot error is a startup error. */
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
  const deployment: Deployment = {
    clock: options.clock ?? wallClock,
    catalogue: assembleCatalogue(options.catalogue),
    defaults: parseScopeConfig(options.defaults ?? {}, providers),
    providers,
    secrets: layerDeploymentCredentials(options.credentials, store),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
  const durableObjects = makeDurableObjects(deployment);
  return {
    media: mediaUrls(options.media),
    durableObjects,
    catalogue: deployment.catalogue,
    queueHandler: deliveryQueueHandler(deployment, bindings),
    scope: (id) => openScope(deployment, bindings, id),
  };
}
