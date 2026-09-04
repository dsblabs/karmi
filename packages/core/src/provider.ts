import type { MediaRef } from "./context.js";
import type { JsonSchema } from "./schema.js";
import type { ProviderConfig } from "./scope-config.js";

// The Provider seam: karmi's own message, event and usage vocabulary. Everything here is plain JSON —
// the Thread DO persists it and rebuilds requests from it after eviction — so nothing may depend on a
// vendor SDK's types (docs/research/provider-seam.md §4).

export type ContentBlock =
  | { type: "text"; text: string }
  /** Binary content by reference; an adapter re-inlines the bytes at request-build. */
  | { type: "media"; media: MediaRef }
  /** `signature` and `redacted` are provider-opaque and replay only to the model that produced them. */
  | { type: "thinking"; text: string; signature?: string; redacted?: boolean }
  /** `signature` carries a Gemini thought signature; replayed only to the same model. */
  | { type: "tool_call"; id: string; name: string; input: unknown; signature?: string }
  /** A Provider Tool call the provider executed itself; `result.raw` replays byte-exact to the same provider, `summary` to any other. */
  | { type: "server_tool"; id: string; name: string; input: unknown; result?: { raw: unknown; summary: string } }
  /** Provider-side Compaction; `raw` replays to the same provider, `summary` stands in elsewhere. */
  | { type: "compaction"; summary: string; raw?: unknown }
  /** Anything else a provider emits that it needs back verbatim; never crosses providers. */
  | { type: "provider"; raw: unknown };

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "pause_turn" | "refusal" | "context_window_exceeded" | "error" | "aborted";

export type Message =
  /** A mid-conversation system message; the Prompt itself travels as `ProviderRequest.system`. */
  | { role: "system"; content: string }
  | { role: "user"; content: ContentBlock[] }
  /** `provider`/`model` name who produced it, so replay can tell a same-model transcript from a switched one. */
  | { role: "assistant"; content: ContentBlock[]; provider: string; model: string; stopReason: StopReason }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError: boolean };

/** Token counts for one model call; `output` already includes `reasoning`. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention; only Anthropic reports the split. */
  cacheWrite1h?: number;
  reasoning?: number;
  serverToolCalls?: number;
  /** Present only when the provider or gateway reported it; karmi never prices tokens. */
  cost?: UsageCost;
  /** The gateway log to join against when the gateway reports no cost in the response. */
  gateway?: { provider: "cloudflare"; id: string };
}

export interface UsageCost {
  amount: number;
  currency: "USD";
  source: "openrouter" | "vercel-gateway";
  basis: "billed" | "list" | "estimate";
  upstream?: number;
  byok?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
}

export interface ProviderRequest {
  /** Provider-native model id: the part after the profile prefix. */
  model: string;
  /** The resolved Provider profile this call runs under. */
  config: ProviderConfig;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "any" | "none" | { name: string };
  parallelToolCalls?: boolean;
  params?: { temperature?: number; topP?: number; maxOutputTokens?: number; reasoning?: "off" | "low" | "medium" | "high" };
  /** Adapter-namespaced escape hatch, already merged over `config.providerOptions`. */
  providerOptions?: Record<string, unknown>;
}

/** Codes line up with the Provider-profile fallback triggers (`fallbackOn`). */
export type ProviderErrorCode = "auth" | "quota" | "rate_limit" | "unavailable" | "invalid_request" | "context_window_exceeded" | "network" | "aborted" | "unknown";

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  raw?: unknown;
}

/**
 * One streamed model call: `message.start`, then `delta`s and completed `part`s in block order, then
 * exactly one terminal `message.end` or `error`. `raw` may appear anywhere and is opt-in passthrough.
 */
export type ProviderEvent =
  | { type: "message.start"; model: string; responseId?: string }
  | { type: "delta"; index: number; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "part"; index: number; block: ContentBlock }
  | { type: "message.end"; stopReason: StopReason; usage: Usage; stopDetails?: unknown }
  | { type: "raw"; raw: unknown }
  | { type: "error"; error: ProviderError };

/** `"unknown"` means send optimistically; the media pipeline substitutes a placeholder only on a definite `false`. */
export interface ModelCapabilities {
  image: boolean | "unknown";
  audio: boolean | "unknown";
  video: boolean | "unknown";
  pdf: boolean | "unknown";
  maxMediaBytes?: number;
}

export interface ProviderCallOptions {
  /** The per-Scope `scopedFetch`; an adapter never reaches for the global. */
  fetch: typeof fetch;
  signal: AbortSignal;
}

/** A model-provider adapter, registered by name in `createKarmi({ providers })` and chosen by a Provider profile. */
export interface Provider {
  stream(request: ProviderRequest, options: ProviderCallOptions): AsyncIterable<ProviderEvent>;
  countTokens?(request: ProviderRequest, options: ProviderCallOptions): Promise<{ tokens: number } | { error: ProviderError }>;
  capabilities(modelId: string): ModelCapabilities;
}
