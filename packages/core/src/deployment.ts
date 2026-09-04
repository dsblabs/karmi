import type { Catalogue } from "./catalogue.js";
import type { ScopeConfigDocument } from "./scope-config.js";

/** A model-provider adapter (wayfinder #44). */
export interface Provider {}

/** Everything `createKarmi` assembled at boot, shared by the Worker and its Durable Objects. */
export interface Deployment {
  readonly catalogue: Catalogue;
  /** Parsed `createKarmi({ defaults })`: the layer every Scope inherits and may only tighten. */
  readonly defaults: ScopeConfigDocument;
  readonly providers: Readonly<Record<string, Provider>>;
}
