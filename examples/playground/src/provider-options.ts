// The Providers that setup offers. The setup command and the Worker both read this list, so it imports nothing.

/** The id of a Provider that setup offers. */
export type ProviderId = "openai" | "anthropic" | "google" | "openrouter" | "custom";

/** One Provider that setup offers. */
export interface ProviderOption {
  id: ProviderId;
  /** The name that setup and the browser show. */
  label: string;
  /** The model that setup suggests. The custom endpoint has no suggestion. */
  defaultModel?: string;
  /** True when each current model of the Provider supports Tool calls. False when it depends on the model. */
  toolCalls: boolean;
  /** True when setup must ask for the base URL of the endpoint. */
  needsBaseUrl?: boolean;
  /**
   * The path of the Provider below a Cloudflare AI Gateway, for example `openai`. A custom endpoint has none, thus it
   * cannot use a gateway.
   */
  gatewayPath?: string;
}

/** The Providers that setup offers, in menu order. */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5", toolCalls: true, gatewayPath: "openai" },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-5", toolCalls: true, gatewayPath: "anthropic" },
  {
    id: "google",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    toolCalls: true,
    gatewayPath: "google-ai-studio/v1beta",
  },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-5", toolCalls: false, gatewayPath: "openrouter" },
  { id: "custom", label: "Custom OpenAI-compatible endpoint", toolCalls: false, needsBaseUrl: true },
];

/** Returns the option with this id, or undefined for an unknown id. */
export function providerOption(id: string | undefined): ProviderOption | undefined {
  return PROVIDER_OPTIONS.find((option) => option.id === id);
}

/**
 * The name of the adapter that serves a Provider in `createKarmi({ providers })`. karmi offers Provider Tools only on
 * the adapter names `anthropic` and `ai-sdk`, thus OpenAI, the one AI SDK Provider with a Provider Tool, uses `ai-sdk`.
 */
export const adapterOf = (id: ProviderId): string => (id === "openai" ? "ai-sdk" : id);

/** The Provider selection that setup stores. It holds no credential. */
export interface ProviderSetup {
  option: ProviderOption;
  model: string;
  /** The endpoint of a custom Provider. */
  baseUrl?: string;
}

/** The model id of a selection in the form `<provider id>/<model>`, for example `openai/gpt-5`. */
export const modelIdOf = (setup: ProviderSetup): string => `${setup.option.id}/${setup.model}`;

/** A Cloudflare AI Gateway that the operator supplied. It holds no credential. */
export interface GatewaySetup {
  accountId: string;
  gatewayId: string;
}

/** The variables of the Worker that hold the selections. */
export interface SetupVars {
  PLAYGROUND_PROVIDER?: string;
  PLAYGROUND_MODEL?: string;
  PLAYGROUND_BASE_URL?: string;
  PLAYGROUND_SECOND_PROVIDER?: string;
  PLAYGROUND_SECOND_MODEL?: string;
  PLAYGROUND_SECOND_BASE_URL?: string;
  PLAYGROUND_GATEWAY_ACCOUNT?: string;
  PLAYGROUND_GATEWAY_ID?: string;
}

/**
 * Reads a Provider selection from the variables: the one of setup, or the optional second one. Returns undefined when
 * setup did not run, is not complete or has no second Provider.
 */
export function readSetup(vars: SetupVars, which: "first" | "second" = "first"): ProviderSetup | undefined {
  const [id, model, baseUrl] =
    which === "first"
      ? [vars.PLAYGROUND_PROVIDER, vars.PLAYGROUND_MODEL, vars.PLAYGROUND_BASE_URL]
      : [vars.PLAYGROUND_SECOND_PROVIDER, vars.PLAYGROUND_SECOND_MODEL, vars.PLAYGROUND_SECOND_BASE_URL];
  const option = providerOption(id);
  if (!option || !model) return undefined;
  if (!option.needsBaseUrl) return { option, model };
  return baseUrl ? { option, model, baseUrl } : undefined;
}

/** Reads the AI Gateway from the variables. Returns undefined when setup has none. */
export function readGateway(vars: SetupVars): GatewaySetup | undefined {
  const { PLAYGROUND_GATEWAY_ACCOUNT: accountId, PLAYGROUND_GATEWAY_ID: gatewayId } = vars;
  return accountId && gatewayId ? { accountId, gatewayId } : undefined;
}
