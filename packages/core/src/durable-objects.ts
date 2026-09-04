import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings.js";
import type { Deployment } from "./deployment.js";
import { ScopeConfigDurableObject } from "./scope-config-do.js";

export interface KarmiDurableObject extends DurableObject<KarmiBindings> {
  readonly deployment: Deployment;
}

export type DurableObjectClass = new (ctx: DurableObjectState, env: KarmiBindings) => KarmiDurableObject;

/** The two Durable Object classes a Worker re-exports by name. */
export interface DurableObjects {
  ThreadDO: DurableObjectClass;
  ScopeConfigDO: DurableObjectClass;
}

/**
 * The classes close over the Deployment so a Thread or ScopeConfig reaches the Catalogue and defaults
 * without a global. The Thread body lands with wayfinder #45.
 */
export function makeDurableObjects(deployment: Deployment): DurableObjects {
  class ThreadDO extends DurableObject<KarmiBindings> {
    readonly deployment = deployment;
  }
  class ScopeConfigDO extends ScopeConfigDurableObject {
    readonly deployment = deployment;
  }
  return { ThreadDO, ScopeConfigDO };
}
