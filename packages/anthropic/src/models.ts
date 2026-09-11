import type { ModelCapabilities } from "@karmi/core";

// What the media pipeline needs to know per model family; unknown ids send optimistically.
const CLAUDE = /^claude-(fable|mythos|opus|sonnet|haiku)-/;
/** Anthropic's request ceiling for a PDF; images are smaller but the pipeline holds one bound per model. */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const UNKNOWN: ModelCapabilities = { image: "unknown", audio: "unknown", video: "unknown", pdf: "unknown" };
/** Every current Claude model takes at least this much; a larger window is opted into per Spec. */
const CONTEXT_WINDOW = 200_000;
const CLAUDE_CAPABILITIES: ModelCapabilities = {
  image: true,
  audio: false,
  video: false,
  pdf: true,
  maxMediaBytes: MAX_MEDIA_BYTES,
  contextWindow: CONTEXT_WINDOW,
};

export function capabilities(modelId: string): ModelCapabilities {
  return CLAUDE.test(modelId) ? CLAUDE_CAPABILITIES : UNKNOWN;
}

/** `max_tokens` is mandatory on the wire; every current model accepts this when the Spec sets none. */
export const DEFAULT_MAX_TOKENS = 16_384;
