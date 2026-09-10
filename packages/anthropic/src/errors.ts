import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { ProviderError, ProviderErrorCode } from "@karmi/core";

// Every failure crosses the seam as a tagged ProviderError; `retryable` drives both karmi's retry and the
// Harness's fallback rotation, so it says what the status means, not how it was transported.

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) return { code: "aborted", message: "The call was aborted.", retryable: false };
  if (error instanceof APIConnectionError) return { code: "network", message: error.message, retryable: true, ...(error.cause !== undefined && { raw: String(error.cause) }) };
  if (error instanceof APIError) {
    const body = error.error as { error?: { code?: string; type?: string; message?: string } } | undefined;
    const code = classify(error.status, body?.error?.type, body?.error?.code, error.message);
    return { code, message: body?.error?.message ?? error.message, retryable: RETRYABLE.has(code), ...(error.status !== undefined && { status: error.status }), ...(error.error !== undefined && { raw: error.error }) };
  }
  return { code: "unknown", message: error instanceof Error ? error.message : String(error), retryable: false };
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limit", "unavailable", "network"]);

function classify(status: number | undefined, type: string | undefined, code: string | undefined, message: string): ProviderErrorCode {
  if (code?.startsWith("egress.")) return "invalid_request";
  switch (status) {
    case 400:
    case 413:
    case 422:
      return /context window|prompt is too long|too many tokens/i.test(message) ? "context_window_exceeded" : type === "billing_error" ? "quota" : "invalid_request";
    case 401:
    case 403:
      return "auth";
    case 402:
      return "quota";
    case 404:
      return "invalid_request";
    case 429:
      return "rate_limit";
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
    case 529:
      return "unavailable";
    default:
      return status !== undefined && status >= 500 ? "unavailable" : "unknown";
  }
}
