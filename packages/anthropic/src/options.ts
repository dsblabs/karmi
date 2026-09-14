import type { ProviderRequest } from "@karmi/core";
import type {
  BetaContextManagementConfig,
  BetaRequestMCPServerURLDefinition,
  BetaThinkingConfigParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * The `providerOptions.anthropic` escape hatch. Each option is forwarded to the Messages API, and the beta
 * header a feature needs is added automatically.
 */
export interface AnthropicOptions {
  /**
   * The thinking config, overriding what `params.reasoning` implies. Adaptive is the only mode on current
   * models.
   */
  thinking?: BetaThinkingConfigParam;
  /** The effort level, overriding what `params.reasoning` implies. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * The server-side fallback chain. `"default"` lets Anthropic pick. Each hop to a fallback model is logged.
   */
  fallbacks?: "default" | { model: string; max_tokens?: number }[];
  /** Context management edits, forwarded as `context_management`. */
  contextManagement?: BetaContextManagementConfig;
  /** A token budget for the whole task, forwarded as `output_config.task_budget`. */
  taskBudget?: { type: "tokens"; total: number };
  /**
   * Native Provider Tool definitions appended after the Harness Tools, e.g.
   * `{ type: "web_search_20260318", name: "web_search" }`.
   */
  serverTools?: BetaToolUnion[];
  /**
   * MCP servers for Anthropic's MCP connector, in addition to the request's own `execution: "provider"`
   * servers.
   */
  mcpServers?: BetaRequestMCPServerURLDefinition[];
  /**
   * Prompt-cache breakpoints on the tools, the system prompt and the last message. On by default with the
   * 5-minute TTL.
   */
  cache?: false | { ttl?: "5m" | "1h" };
  /** Extra beta headers, merged with the ones the other options infer. */
  betas?: string[];
  /** Whether every SSE event is also emitted as a `raw` ProviderEvent. */
  raw?: boolean;
}

/** The `anthropic` namespace of the request's provider options, or an empty object. */
export function anthropicOptions(request: ProviderRequest): AnthropicOptions {
  return (request.providerOptions?.anthropic as AnthropicOptions | undefined) ?? {};
}
