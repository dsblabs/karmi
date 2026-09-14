import type { MediaWriter } from "./media";
import type { Logger, MediaRef } from "./context";
import type { JsonSchema } from "./schema";
import type { ProviderConfig } from "./scope-config";
import type { SensitiveValue } from "./secrets";
import type { ProviderCredentials } from "./secrets";

// The Provider seam: karmi's own message, event and usage vocabulary. Everything here is plain JSON,
// because the Thread Durable Object persists it and rebuilds requests from it after eviction. Nothing
// here may depend on a vendor SDK's types (docs/research/provider-seam.md §4).

/** One block of a message's content, in the shape karmi persists and replays across providers. */
export type ContentBlock = (
  | { type: "text"; text: string }
  /** Binary content by reference. An adapter re-inlines the bytes when it builds the request. */
  | { type: "media"; media: MediaRef }
  /**
   * A reference in a Tool result that loads the Deferred Tool `name`. Anthropic encodes it natively.
   * Other adapters send text and resend the definition.
   */
  | { type: "tool_reference"; name: string }
  /**
   * A thinking block. `signature` and `redacted` are provider-opaque and replay only to the model
   * that produced them.
   */
  | { type: "thinking"; text: string; signature?: string; redacted?: boolean }
  /**
   * A tool call the model made. `signature` carries a Gemini thought signature and replays only to the same
   * model.
   */
  | { type: "tool_call"; id: string; name: string; input: unknown; signature?: string }
  /**
   * A Provider Tool call the provider executed itself. `result.raw` replays byte-exact to the same
   * provider, and `summary` stands in for it on any other.
   */
  | { type: "server_tool"; id: string; name: string; input: unknown; result?: { raw: unknown; summary: string } }
  /**
   * A provider-side Compaction. `raw` replays to the same provider, and `summary` stands in for it elsewhere.
   */
  | { type: "compaction"; summary: string; raw?: unknown }
  /** Anything else a provider emits that it needs back verbatim. It never crosses providers. */
  | { type: "provider"; raw: unknown }
) & {
  /**
   * Replay metadata that travels with the block. It is model-scoped for text, thinking and calls, and
   * provider-scoped for the opaque block types.
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
};

/** Why a model call ended. */
export type StopReason =
  "end_turn" | "max_tokens" | "tool_use" | "pause_turn" | "refusal" | "context_window_exceeded" | "error" | "aborted";

/** One message of a transcript as karmi persists it. */
export type Message =
  /** A mid-conversation system message. The Prompt itself travels as `ProviderRequest.system`. */
  | { role: "system"; content: string }
  | { role: "user"; content: ContentBlock[] }
  /**
   * A model's reply. `provider` and `model` record who produced it, so replay can tell a same-model
   * transcript from one that switched models.
   */
  | { role: "assistant"; content: ContentBlock[]; provider: string; model: string; stopReason: StopReason }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError: boolean };

/** The token counts of one model call. `output` already includes `reasoning`. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The subset of `cacheWrite` written with one-hour retention. Only Anthropic reports the split. */
  cacheWrite1h?: number;
  reasoning?: number;
  serverToolCalls?: number;
  /** The cost the provider or gateway reported. karmi never prices tokens itself. */
  cost?: UsageCost;
  /** The gateway log entry to join against when the gateway reports no cost in the response. */
  gateway?: { provider: "cloudflare"; id: string };
}

/** The cost of one model call as a provider or gateway reported it. */
export interface UsageCost {
  amount: number;
  currency: "USD";
  /** Who reported the cost. */
  source: "openrouter" | "vercel-gateway";
  /** Whether the amount is what was billed, the list price, or an estimate. */
  basis: "billed" | "list" | "estimate";
  /** The upstream provider's own charge, when the gateway reports it separately. */
  upstream?: number;
  /** Whether the call ran on the developer's own provider key through the gateway. */
  byok?: boolean;
}

/** A Tool as it is offered to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Whether the provider must constrain output to the schema exactly, where it supports that. */
  strict?: boolean;
  /**
   * Whether the Tool is a Deferred Tool, kept out of the model's initial context until a
   * `tool_reference` in the transcript loads it. An adapter with native support encodes that. Any
   * other adapter offers the definition once `loadedToolNames` names it.
   */
  deferred?: boolean;
}

/**
 * An MCP server the provider connects to itself (`execution: "provider"`), with the token the registry
 * resolved.
 */
export interface ProviderMcpServer {
  name: string;
  url: string;
  /** The bearer token for the server, when it needs one. */
  authorization?: SensitiveValue;
  /** The server's own tool names an Agent may see. Absent means every tool. */
  allow?: string[];
  /** The server's own tool names an Agent may never see. */
  deny?: string[];
}

/** One model call as the Harness hands it to an adapter. */
export interface ProviderRequest {
  /** The provider-native model id, which is the part after the profile prefix. */
  model: string;
  /** The resolved Provider profile this call runs under. */
  config: ProviderConfig;
  /** The evaluated Prompt. */
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "any" | "none" | { name: string };
  parallelToolCalls?: boolean;
  params?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    reasoning?: "off" | "low" | "medium" | "high";
  };
  /** Adapter-namespaced options, already merged over `config.providerOptions`. */
  providerOptions?: Record<string, unknown>;
  /** Servers for the provider's own MCP connector. An adapter without one answers `invalid_request`. */
  mcpServers?: ProviderMcpServer[];
  /**
   * A request to compact `messages` through the provider's own mechanism and answer with a
   * `compaction` block. Set only under `ProviderConfig.compaction: "provider"`. An adapter without
   * such a mechanism answers nothing.
   */
  compact?: { instructions?: string };
}

/**
 * The class of a provider failure. The codes line up with the Provider profile's fallback triggers
 * (`fallbackOn`).
 */
export type ProviderErrorCode =
  | "auth"
  | "quota"
  | "rate_limit"
  | "unavailable"
  | "invalid_request"
  | "context_window_exceeded"
  | "network"
  | "aborted"
  | "unknown";

/** A failed model call as an adapter reports it. */
export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  /** Whether the same call may be retried as is. */
  retryable: boolean;
  /** The HTTP status, when there was one. */
  status?: number;
  /** The provider's own error body. */
  raw?: unknown;
}

/**
 * One event of a streamed model call. A call emits `message.start`, then `delta`s and completed
 * `part`s in block order, then exactly one terminal `message.end` or `error`. `raw` may appear
 * anywhere and is an opt-in passthrough of the provider's own event.
 */
export type ProviderEvent =
  | { type: "message.start"; model: string; responseId?: string }
  | { type: "delta"; index: number; kind: "text" | "thinking" | "tool_input"; text: string }
  | { type: "part"; index: number; block: ContentBlock }
  | { type: "message.end"; stopReason: StopReason; usage: Usage; stopDetails?: unknown }
  | { type: "raw"; raw: unknown }
  | { type: "error"; error: ProviderError };

/**
 * What a model accepts. `"unknown"` means the media is sent optimistically. The media pipeline
 * substitutes a placeholder only on a definite `false`.
 */
export interface ModelCapabilities {
  image: boolean | "unknown";
  audio: boolean | "unknown";
  video: boolean | "unknown";
  pdf: boolean | "unknown";
  /** The largest media object the model accepts inline, in bytes. */
  maxMediaBytes?: number;
  /** The model's context window in tokens. It is the Compaction default when the Agent Spec sets none. */
  contextWindow?: number;
}

/** What the Harness gives an adapter alongside the request. */
export interface ProviderCallOptions {
  /** Media storage for the Thread, for reading referenced bytes and storing bytes the model produces. */
  media?: MediaWriter & { get(ref: MediaRef): Promise<ArrayBuffer | undefined> };
  /** The Scoped fetch for this Turn. An adapter never uses the global `fetch`. */
  fetch: typeof fetch;
  signal: AbortSignal;
  /** Who the call is for. An adapter may stamp it on its own gateway but never on a third party. */
  attribution?: CallAttribution;
  logger?: Logger;
  /**
   * The profile's credentials, resolved for this one call. An adapter calls `expose()` on them while
   * building the request.
   */
  credentials?: ProviderCredentials;
}

/** The Scope, Agent, Thread and Turn a model call is made for. */
export interface CallAttribution {
  scope: string;
  agent: string;
  thread: string;
  turn: number;
}

/**
 * A model-provider adapter, registered by name in `createKarmi({ providers })` and chosen by a Provider
 * profile.
 */
export interface Provider {
  /** Runs one model call and streams its events. */
  stream(request: ProviderRequest, options: ProviderCallOptions): AsyncIterable<ProviderEvent>;
  /** Counts the tokens `request` would carry, where the provider offers a count. */
  countTokens?(
    request: ProviderRequest,
    options: ProviderCallOptions,
  ): Promise<{ tokens: number } | { error: ProviderError }>;
  /** What the model `modelId` accepts. */
  capabilities(modelId: string): ModelCapabilities;
}
