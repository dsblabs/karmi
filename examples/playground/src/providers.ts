import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { aiSdk, type ModelFactoryContext } from "@karmi/ai-sdk";
import { anthropic } from "@karmi/anthropic";
import { GATEWAY_HOST, type Provider, type ProviderConfig } from "@karmi/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  adapterOf,
  modelIdOf,
  providerOption,
  readGateway,
  readSetup,
  type ProviderId,
  type ProviderSetup,
  type SetupVars,
} from "./provider-options";

/** One Provider profile of the Deployment that the Provider scenario can switch to. It holds no credential value. */
export interface ProfileChoice {
  /** The name of the profile in `defaults.providers`. */
  name: string;
  /** The Provider of the profile, as the page shows it. */
  label: string;
  /** The model id that an Agent on this profile uses, for example `openai/gpt-5`. */
  model: string;
  /** The profile itself. It names each credential, never a value. */
  config: ProviderConfig;
}

/** The Provider profile that the Agents of each other scenario use. */
export const DEFAULT_PROFILE = "default";
/** The profile of the optional second Provider of setup. */
export const SECOND_PROFILE = "second";
/** The profile that sends the requests of the Provider of setup through the optional AI Gateway. */
export const GATEWAY_PROFILE = "gateway";

function apiKeyOf({ credentials }: ModelFactoryContext): string {
  const apiKey = credentials?.provider?.expose();
  if (!apiKey) throw new Error("The Playground has no Provider credential. Run `pnpm setup`.");
  return apiKey;
}

/**
 * The client settings of an AI SDK call. A gateway profile sends each request to the path of the Provider below the
 * gateway, with the gateway token and the attribution of the call as `cf-aig-*` headers. The Anthropic adapter does
 * the same for its own profiles.
 */
function clientOf(input: ModelFactoryContext, id: ProviderId): { baseURL?: string; headers?: Record<string, string> } {
  const { gateway } = input.config;
  const path = providerOption(id)?.gatewayPath;
  if (!gateway || !path) return input.config.baseUrl ? { baseURL: input.config.baseUrl } : {};
  const token = input.credentials?.gateway?.expose();
  return {
    baseURL: `https://${GATEWAY_HOST}/v1/${gateway.accountId}/${gateway.gatewayId}/${path}`,
    headers: {
      ...(token && { "cf-aig-authorization": `Bearer ${token}` }),
      ...(input.attribution && { "cf-aig-metadata": JSON.stringify(input.attribution) }),
    },
  };
}

/** Builds the Provider of one Provider id. Anthropic uses the native adapter. Each other one uses the AI SDK. */
function buildProvider(id: ProviderId): Provider {
  switch (id) {
    case "anthropic":
      return anthropic();
    case "openai":
      return aiSdk((input) =>
        createOpenAI({ apiKey: apiKeyOf(input), fetch: input.fetch, ...clientOf(input, id) })(input.modelId),
      );
    case "google":
      return aiSdk((input) =>
        createGoogleGenerativeAI({ apiKey: apiKeyOf(input), fetch: input.fetch, ...clientOf(input, id) })(
          input.modelId,
        ),
      );
    case "openrouter":
      return aiSdk((input) =>
        createOpenRouter({ apiKey: apiKeyOf(input), fetch: input.fetch, ...clientOf(input, id) })(input.modelId),
      );
    case "custom":
      return aiSdk((input) => {
        const { baseURL } = clientOf(input, id);
        if (!baseURL) throw new Error("The custom Provider has no base URL. Run `pnpm setup`.");
        return createOpenAICompatible({ name: "custom", baseURL, apiKey: apiKeyOf(input), fetch: input.fetch })(
          input.modelId,
        );
      });
  }
}

/** The profile of a selection without its credential. It serves the model ids with the Provider id as prefix. */
const profileOf = (setup: ProviderSetup): ProviderConfig => ({
  adapter: adapterOf(setup.option.id),
  models: [`${setup.option.id}/*`],
  ...(setup.baseUrl && { baseUrl: setup.baseUrl }),
});

/** The names of the Deployment credentials in `createKarmi({ credentials })`. A profile names each one with `ref`. */
const CREDENTIALS = { provider: "provider", second: "second-provider", gateway: "gateway" } as const;
const ref = (name: string) => `deployment:${name}`;

/** The variables and secrets of the Worker that the Provider profiles read. */
export interface ProviderVars extends SetupVars {
  PROVIDER_API_KEY?: string;
  SECOND_PROVIDER_API_KEY?: string;
  GATEWAY_TOKEN?: string;
}

/** The Providers, credentials and profiles of `createKarmi` for the selections of setup. */
export interface DeploymentProviders {
  /** The first Provider selection of setup, which the `default` profile uses. */
  setup: ProviderSetup;
  providers: Record<string, Provider>;
  credentials: Record<string, string>;
  choices: ProfileChoice[];
}

/**
 * Builds the Provider profiles of setup: `default` always, `second` with a second Provider and `gateway` with an AI
 * Gateway. A custom endpoint cannot use a gateway. Returns undefined when setup did not run.
 */
export function deploymentProviders(vars: ProviderVars): DeploymentProviders | undefined {
  const first = readSetup(vars);
  if (!first || !vars.PROVIDER_API_KEY) return undefined;
  const second = vars.SECOND_PROVIDER_API_KEY ? readSetup(vars, "second") : undefined;
  const gateway = first.option.gatewayPath ? readGateway(vars) : undefined;
  const choice = (name: string, setup: ProviderSetup, config: ProviderConfig): ProfileChoice => ({
    name,
    label: setup.option.label,
    model: modelIdOf(setup),
    config,
  });
  const choices = [
    choice(DEFAULT_PROFILE, first, { ...profileOf(first), credential: ref(CREDENTIALS.provider) }),
    ...(second ? [choice(SECOND_PROFILE, second, { ...profileOf(second), credential: ref(CREDENTIALS.second) })] : []),
    ...(gateway
      ? [
          choice(GATEWAY_PROFILE, first, {
            ...profileOf(first),
            credential: ref(CREDENTIALS.provider),
            gateway: {
              kind: "cloudflare",
              ...gateway,
              ...(vars.GATEWAY_TOKEN && { credential: ref(CREDENTIALS.gateway) }),
            },
          }),
        ]
      : []),
  ];
  const ids = new Set([first.option.id, ...(second ? [second.option.id] : [])]);
  return {
    setup: first,
    providers: Object.fromEntries([...ids].map((id) => [adapterOf(id), buildProvider(id)])),
    credentials: {
      [CREDENTIALS.provider]: vars.PROVIDER_API_KEY,
      ...(second && vars.SECOND_PROVIDER_API_KEY && { [CREDENTIALS.second]: vars.SECOND_PROVIDER_API_KEY }),
      ...(gateway && vars.GATEWAY_TOKEN && { [CREDENTIALS.gateway]: vars.GATEWAY_TOKEN }),
    },
    choices,
  };
}

/** The `defaults.providers` of `createKarmi` for a list of choices. */
export const profilesOf = (choices: readonly ProfileChoice[]): Record<string, ProviderConfig> =>
  Object.fromEntries(choices.map((choice) => [choice.name, choice.config]));
