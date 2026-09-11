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

export interface KarmiOptions<Env = unknown> {
  catalogue: CatalogueInput;
  clock?: Clock;
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
  const deployment: Deployment = {
    clock: options.clock ?? wallClock,
    catalogue: assembleCatalogue(options.catalogue),
    defaults: parseScopeConfig(options.defaults ?? {}, providers),
    providers,
  };
  const durableObjects = makeDurableObjects(deployment);
  const bindings = resolveBindings(env as Env, options.bindings);
  return {
    durableObjects,
    catalogue: deployment.catalogue,
    queueHandler: deliveryQueueHandler(bindings, deployment.catalogue),
    scope: (id) => openScope(bindings, id),
  };
}
