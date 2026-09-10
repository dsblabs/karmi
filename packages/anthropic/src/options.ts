import type { ProviderRequest } from "@karmi/core";
import type { BetaContextManagementConfig, BetaRequestMCPServerURLDefinition, BetaThinkingConfigParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** The `providerOptions.anthropic` escape hatch: forwarded to the Messages API, betas inferred where the feature needs one. */
export interface AnthropicOptions {
  /** Overrides what `params.reasoning` implies; adaptive is the only mode on current models. */
  thinking?: BetaThinkingConfigParam;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side fallback chain; `"default"` lets Anthropic pick. The served model is logged as a hop. */
  fallbacks?: "default" | { model: string; max_tokens?: number }[];
  contextManagement?: BetaContextManagementConfig;
  taskBudget?: { type: "tokens"; total: number };
  /** Native Provider Tool definitions appended after the Harness Tools, e.g. `{ type: "web_search_20260318", name: "web_search" }`. */
  serverTools?: BetaToolUnion[];
  mcpServers?: BetaRequestMCPServerURLDefinition[];
  /** Prompt-cache breakpoints on tools, system and the last message; on by default with the 5-minute TTL. */
  cache?: false | { ttl?: "5m" | "1h" };
  betas?: string[];
  /** Emit every SSE event as a `raw` ProviderEvent. */
  raw?: boolean;
}

export function anthropicOptions(request: ProviderRequest): AnthropicOptions {
  return (request.providerOptions?.anthropic as AnthropicOptions | undefined) ?? {};
}
