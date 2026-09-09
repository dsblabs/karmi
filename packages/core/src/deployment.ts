import type { Catalogue } from "./catalogue.js";
import type { Clock } from "./clock.js";
import type { Provider } from "./provider.js";
import type { ScopeConfigDocument } from "./scope-config.js";

/** Everything `createKarmi` assembled at boot, shared by the Worker and its Durable Objects. */
export interface Deployment {
  readonly clock: Clock;
  readonly catalogue: Catalogue;
  /** Parsed `createKarmi({ defaults })`: the layer every Scope inherits and may only tighten. */
  readonly defaults: ScopeConfigDocument;
  readonly providers: Readonly<Record<string, Provider>>;
}
