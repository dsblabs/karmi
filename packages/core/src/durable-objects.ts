import type { DurableObject } from "cloudflare:workers";
import type { KarmiBindings } from "./bindings";
import type { Deployment } from "./deployment";
import { MemoryDurableObject } from "./memory-do";
import { ScopeConfigDurableObject } from "./scope-config-do";
import { ThreadDurableObject } from "./thread-do";

/** A karmi Durable Object. Every one carries the Deployment it was created for. */
export interface KarmiDurableObject extends DurableObject<KarmiBindings> {
  readonly deployment: Deployment;
}

/** The constructor shape of a karmi Durable Object class. */
export type DurableObjectClass = new (ctx: DurableObjectState, env: KarmiBindings) => KarmiDurableObject;

/** The three Durable Object classes a Worker re-exports by name. */
export interface DurableObjects {
  ThreadDO: DurableObjectClass;
  ScopeConfigDO: DurableObjectClass;
  MemoryDO: DurableObjectClass;
}

/**
 * Builds the three Durable Object classes for `deployment`. The classes close over the Deployment so a
 * Thread, ScopeConfig or Memory object reaches the Catalogue and defaults without a global.
 */
export function makeDurableObjects(deployment: Deployment): DurableObjects {
  class ThreadDO extends ThreadDurableObject {
    readonly deployment = deployment;
  }
  class ScopeConfigDO extends ScopeConfigDurableObject {
    readonly deployment = deployment;
  }
  class MemoryDO extends MemoryDurableObject {
    readonly deployment = deployment;
  }
  return { ThreadDO, ScopeConfigDO, MemoryDO };
}
