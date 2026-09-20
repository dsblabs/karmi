import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { aiSdk, type ModelFactoryContext } from "@karmi/ai-sdk";
import { anthropic } from "@karmi/anthropic";
import type { Provider } from "@karmi/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ProviderSetup } from "./provider-options";

/** The name of the one Provider and the model id prefix that each Playground Agent uses. */
export const ADAPTER = "playground";

function apiKeyOf({ credentials }: ModelFactoryContext): string {
  const apiKey = credentials?.provider?.expose();
  if (!apiKey) throw new Error("The Playground has no Provider credential. Run `pnpm setup`.");
  return apiKey;
}

/** Builds the Provider for the selection of setup. Anthropic uses the native adapter. Each other one uses the AI SDK. */
export function buildProvider(setup: ProviderSetup): Provider {
  switch (setup.option.id) {
    case "anthropic":
      return anthropic();
    case "openai":
      return aiSdk((input) => createOpenAI({ apiKey: apiKeyOf(input), fetch: input.fetch })(input.modelId));
    case "google":
      return aiSdk((input) => createGoogleGenerativeAI({ apiKey: apiKeyOf(input), fetch: input.fetch })(input.modelId));
    case "openrouter":
      return aiSdk((input) => createOpenRouter({ apiKey: apiKeyOf(input), fetch: input.fetch })(input.modelId));
    case "custom":
      return aiSdk((input) =>
        createOpenAICompatible({
          name: "custom",
          baseURL: setup.baseUrl ?? "",
          apiKey: apiKeyOf(input),
          fetch: input.fetch,
        })(input.modelId),
      );
  }
}
