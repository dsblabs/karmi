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
}

/** The Providers that setup offers, in menu order. */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5", toolCalls: true },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-5", toolCalls: true },
  { id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-flash", toolCalls: true },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-5", toolCalls: false },
  { id: "custom", label: "Custom OpenAI-compatible endpoint", toolCalls: false, needsBaseUrl: true },
];

/** Returns the option with this id, or undefined for an unknown id. */
export function providerOption(id: string | undefined): ProviderOption | undefined {
  return PROVIDER_OPTIONS.find((option) => option.id === id);
}

/** The Provider selection that setup stores. It holds no credential. */
export interface ProviderSetup {
  option: ProviderOption;
  model: string;
  /** The endpoint of a custom Provider. */
  baseUrl?: string;
}

/** The variables of the Worker that hold the selection. */
export interface SetupVars {
  PLAYGROUND_PROVIDER?: string;
  PLAYGROUND_MODEL?: string;
  PLAYGROUND_BASE_URL?: string;
}

/** Reads the Provider selection from the variables. Returns undefined when setup did not run or is not complete. */
export function readSetup(vars: SetupVars): ProviderSetup | undefined {
  const option = providerOption(vars.PLAYGROUND_PROVIDER);
  const model = vars.PLAYGROUND_MODEL;
  if (!option || !model) return undefined;
  if (!option.needsBaseUrl) return { option, model };
  return vars.PLAYGROUND_BASE_URL ? { option, model, baseUrl: vars.PLAYGROUND_BASE_URL } : undefined;
}
