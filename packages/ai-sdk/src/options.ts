import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { z } from "zod";
import type { ProviderRequest } from "@karmi/core";

export const metadataSchema = z.record(z.string(), z.record(z.string(), z.json()));
const optionsSchema = z.strictObject({ aiSdk: metadataSchema.optional() });

/** The escape hatch is namespaced JSON, as required by the AI SDK provider contract. */
export function providerOptions(request: ProviderRequest) {
  return optionsSchema.parse(request.providerOptions ?? request.config.providerOptions ?? {}).aiSdk ?? {};
}

/** OpenRouter v3 still reads reasoning from its native options, unlike the other V4 providers. */
export function mapProviderOptions(
  options: SharedV4ProviderOptions,
  request: ProviderRequest,
  provider: string,
): SharedV4ProviderOptions {
  const namespace = provider.split(".")[0] ?? provider;
  const native: SharedV4ProviderOptions[string] = {};
  if (namespace === "openrouter" && request.params?.reasoning)
    native.reasoning = { effort: request.params.reasoning === "off" ? "none" : request.params.reasoning };
  if (request.parallelToolCalls !== undefined) {
    if (namespace === "openai") native.parallelToolCalls = request.parallelToolCalls;
    if (namespace === "anthropic") native.disableParallelToolUse = !request.parallelToolCalls;
    if (namespace === "openrouter") native.parallel_tool_calls = request.parallelToolCalls;
  }
  return Object.keys(native).length ? { ...options, [namespace]: { ...native, ...options[namespace] } } : options;
}
