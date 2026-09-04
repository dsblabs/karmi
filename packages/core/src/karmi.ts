import { env } from "cloudflare:workers";
import { resolveBindings, type BindingsResolver } from "./bindings.js";
import { assembleCatalogue, type Catalogue, type CatalogueInput } from "./catalogue.js";
import { assertCompatibilityBaseline } from "./compat.js";
import { makeDurableObjects, type DurableObjects } from "./durable-objects.js";
import { KarmiError } from "./errors.js";
import { assertScopeId, type Scope } from "./scope.js";

/** Deployment-wide defaults every Scope inherits and may only tighten (wayfinder #43). */
export interface DeploymentDefaults {}

/** A model-provider adapter (wayfinder #44). */
export interface Provider {}

export interface KarmiOptions<Env = unknown> {
  catalogue: CatalogueInput;
  defaults?: DeploymentDefaults;
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
  const catalogue = assembleCatalogue(options.catalogue);
  const durableObjects = makeDurableObjects(catalogue);
  const bindings = () => resolveBindings(env as Env, options.bindings);
  return {
    durableObjects,
    catalogue,
    queueHandler: () => {
      throw new KarmiError("queue.unhandled", "karmi's Queue consumer lands with the Deliverer and Usage tickets.");
    },
    scope(id) {
      assertScopeId(id);
      bindings();
      return { id };
    },
  };
}
