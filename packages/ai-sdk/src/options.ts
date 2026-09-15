import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { z } from "zod";
import type { ProviderRequest } from "@karmi/core";

/** The schema of AI SDK provider metadata: a JSON record per provider namespace. */
export const metadataSchema = z.record(z.string(), z.record(z.string(), z.json()));
const optionsSchema = z.strictObject({
  aiSdk: metadataSchema.optional(),
  openai: z.object({ serverTools: z.unknown().optional() }).optional(),
});

/**
 * The `aiSdk` namespace of the request's provider options, validated as the namespaced JSON the AI SDK
 * expects.
 */
export function providerOptions(request: ProviderRequest) {
  return optionsSchema.parse(request.providerOptions ?? request.config.providerOptions ?? {}).aiSdk ?? {};
}

/**
 * Adds the native options a provider needs for reasoning and parallel tool calls under its namespace.
 * Options already present under that namespace win over the derived ones.
 */
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
