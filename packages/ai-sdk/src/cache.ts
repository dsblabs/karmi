import type { LanguageModelV4CallOptions, SharedV4ProviderOptions } from "@ai-sdk/provider";

/** The prompt-cache setting of `aiSdk`: `false` turns caching off, and an object sets the TTL. */
export type CacheOption = false | { ttl?: "5m" | "1h" };

/**
 * Adds prompt-cache breakpoints to `params`: on the system message, the last function Tool and the last
 * message. With `cache: false` it does nothing.
 */
export function addCacheBreakpoints(params: LanguageModelV4CallOptions, cache: CacheOption | undefined): void {
  if (cache === false) return;
  const cacheControl = { type: "ephemeral", ...(cache?.ttl && { ttl: cache.ttl }) };
  // The hint goes in the `anthropic` namespace, because @ai-sdk/anthropic and @openrouter/ai-sdk-provider both
  // read it there. Providers that cache automatically ignore it. The objects are copied, because a system
  // message can be the request's own object.
  const mark = (options: SharedV4ProviderOptions | undefined): SharedV4ProviderOptions => ({
    ...options,
    anthropic: { ...options?.anthropic, cacheControl },
  });
  const system = params.prompt.findIndex((message) => message.role === "system");
  for (const index of new Set([system, params.prompt.length - 1])) {
    const message = params.prompt[index];
    if (message) params.prompt[index] = { ...message, providerOptions: mark(message.providerOptions) };
  }
  const tool = params.tools?.findLastIndex((value) => value.type === "function") ?? -1;
  const definition = params.tools?.[tool];
  if (params.tools && definition?.type === "function")
    params.tools[tool] = { ...definition, providerOptions: mark(definition.providerOptions) };
}
