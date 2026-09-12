import type { Catalogue } from "./catalogue";
import type { Clock } from "./clock";
import type { Provider } from "./provider";
import type { ScopeConfigDocument } from "./scope-config";
import type { SecretsProvider } from "./secrets";

/** Everything `createKarmi` assembled at boot, shared by the Worker and its Durable Objects. */
export interface Deployment {
  readonly clock: Clock;
  readonly catalogue: Catalogue;
  /** Parsed `createKarmi({ defaults })`: the layer every Scope inherits and may only tighten. */
  readonly defaults: ScopeConfigDocument;
  readonly providers: Readonly<Record<string, Provider>>;
  /** Where Provider credentials resolve from, with `createKarmi({ credentials })` layered in front. */
  readonly secrets: SecretsProvider;
}
