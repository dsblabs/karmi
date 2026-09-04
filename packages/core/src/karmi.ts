import { env } from "cloudflare:workers";
import { resolveBindings, type BindingsResolver } from "./bindings.js";
import { assembleCatalogue, type Catalogue, type CatalogueInput } from "./catalogue.js";
import { assertCompatibilityBaseline } from "./compat.js";
import type { Deployment } from "./deployment.js";
import { makeDurableObjects, type DurableObjects } from "./durable-objects.js";
import { KarmiError } from "./errors.js";
import type { Provider } from "./provider.js";
import { parseScopeConfig, type ScopeConfigDocument } from "./scope-config.js";
import { openScope, type Scope } from "./scope.js";

export interface KarmiOptions<Env = unknown> {
  catalogue: CatalogueInput;
  /** Deployment-wide layer every Scope inherits and may only tighten: the same shape as a Scope config. */
  defaults?: ScopeConfigDocument;
  providers?: Record<string, Provider>;
  bindings?: BindingsResolver<Env>;
}

export interface Karmi {
  readonly durableObjects: DurableObjects;
  readonly catalogue: Catalogue;
  readonly queueHandler: ExportedHandlerQueueHandler;
  scope(id: string): Scope;
}

/** Assembles a Deployment: runs at module evaluation, so every boot error is a startup error. */
export function createKarmi<Env = unknown>(options: KarmiOptions<Env>): Karmi {
  assertCompatibilityBaseline();
  const providers = options.providers ?? {};
  const deployment: Deployment = { catalogue: assembleCatalogue(options.catalogue), defaults: parseScopeConfig(options.defaults ?? {}, providers), providers };
  const durableObjects = makeDurableObjects(deployment);
  const bindings = resolveBindings(env as Env, options.bindings);
  return {
    durableObjects,
    catalogue: deployment.catalogue,
    queueHandler: () => {
      throw new KarmiError("queue.unhandled", "karmi's Queue consumer lands with the Deliverer and Usage tickets.");
    },
    scope: (id) => openScope(bindings, id),
  };
}
