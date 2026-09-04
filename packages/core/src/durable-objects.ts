import { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings.js";
import type { Catalogue } from "./catalogue.js";

export interface KarmiDurableObject extends DurableObject<KarmiBindings> {
  readonly catalogue: Catalogue;
}

export type DurableObjectClass = new (ctx: DurableObjectState, env: KarmiBindings) => KarmiDurableObject;

/** The two Durable Object classes a Worker re-exports by name. */
export interface DurableObjects {
  ThreadDO: DurableObjectClass;
  ScopeConfigDO: DurableObjectClass;
}

/**
 * The classes close over the Catalogue so a Thread or ScopeConfig reaches behaviour code without a
 * global. Bodies land with wayfinder #43 (ScopeConfig) and #45 (Thread).
 */
export function makeDurableObjects(catalogue: Catalogue): DurableObjects {
  class ThreadDO extends DurableObject<KarmiBindings> {
    readonly catalogue = catalogue;
  }
  class ScopeConfigDO extends DurableObject<KarmiBindings> {
    readonly catalogue = catalogue;
  }
  return { ThreadDO, ScopeConfigDO };
}
