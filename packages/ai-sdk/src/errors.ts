import { APICallError, LoadAPIKeyError, TypeValidationError, UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { ZodError } from "zod";
import type { ProviderError, ProviderErrorCode } from "@karmi/core";

/** Thrown while building a request the AI SDK cannot express. It maps to the `invalid_request` code. */
export class InvalidRequestError extends Error {}

/** Maps an AI SDK or fetch error to a ProviderError with a code, message and retryable flag. */
export function toProviderError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") return { code: "aborted", message, retryable: false };
  if (LoadAPIKeyError.isInstance(error)) return { code: "auth", message, retryable: false };
  if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof InvalidRequestError ||
    TypeValidationError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error)
  )
    return { code: "invalid_request", message, retryable: false };
  if (error instanceof TypeError) return { code: "network", message, retryable: true };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    return {
      code: classify(status, message),
      message,
      retryable: error.isRetryable,
      ...(status === undefined ? {} : { status }),
    };
  }
  return { code: "unknown", message, retryable: false };
}

function classify(status: number | undefined, message: string): ProviderErrorCode {
  if (status === undefined) return "network";
  if (/context window|context length|prompt is too long|too many tokens/i.test(message))
    return "context_window_exceeded";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 408 || status >= 500) return "unavailable";
  return "invalid_request";
}
