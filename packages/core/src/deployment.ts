import type { Catalogue } from "./catalogue";
import type { Clock } from "./clock";
import type { Logger } from "./context";
import type { McpClientIdentity } from "./mcp-auth";
import type { Provider } from "./provider";
import type { ScopeConfigDocument } from "./scope-config";
import type { SecretsProvider } from "./secrets";

/** Everything `createKarmi` assembled at boot, shared by the Worker and its Durable Objects. */
export interface Deployment {
  readonly clock: Clock;
  /** The Logger every line goes through, before karmi binds its attribution fields. */
  readonly logger: Logger;
  readonly catalogue: Catalogue;
  /** The parsed `createKarmi({ defaults })`. Every Scope inherits this layer and may only tighten it. */
  readonly defaults: ScopeConfigDocument;
  /** The Providers by name. */
  readonly providers: Readonly<Record<string, Provider>>;
  /**
   * The Secrets provider that Provider credentials resolve from, with `createKarmi({ credentials })` layered
   * in front.
   */
  readonly secrets: SecretsProvider;
  /** The transport under every Scoped fetch. It is the global `fetch` unless a test supplies one. */
  readonly fetch: typeof fetch;
  /**
   * The OAuth client this Deployment presents to MCP authorization servers. Without it, OAuth servers cannot
   * be used.
   */
  readonly oauth?: McpClientIdentity;
}
