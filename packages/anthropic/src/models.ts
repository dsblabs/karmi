import type { ModelCapabilities } from "@karmi/core";

// The media pipeline reads these per model family. An unknown model id reports every modality as unknown,
// so media is sent optimistically.
const CLAUDE = /^claude-(fable|mythos|opus|sonnet|haiku)-/;
/**
 * Anthropic's request ceiling for a PDF. Images are limited lower, but the pipeline holds one bound per model.
 */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const UNKNOWN: ModelCapabilities = { image: "unknown", audio: "unknown", video: "unknown", pdf: "unknown" };
/** The context window every current Claude model has. A larger window is opted into per Agent Spec. */
const CONTEXT_WINDOW = 200_000;
const CLAUDE_CAPABILITIES: ModelCapabilities = {
  image: true,
  audio: false,
  video: false,
  pdf: true,
  maxMediaBytes: MAX_MEDIA_BYTES,
  contextWindow: CONTEXT_WINDOW,
};

/** The capabilities of `modelId`: full for a Claude model, unknown for any other id. */
export function capabilities(modelId: string): ModelCapabilities {
  return CLAUDE.test(modelId) ? CLAUDE_CAPABILITIES : UNKNOWN;
}

/**
 * The `max_tokens` sent when the Spec sets none. The API requires the field and every current model accepts
 * this.
 */
export const DEFAULT_MAX_TOKENS = 16_384;
