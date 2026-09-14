import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { ProviderError, ProviderErrorCode } from "@karmi/core";

// Every failure crosses the Provider seam as a tagged ProviderError. `retryable` drives both karmi's retry
// and the Harness's fallback rotation, so it reflects what the status means rather than how it was transported.

/** Maps an SDK or fetch error to a ProviderError with a code, message and retryable flag. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError"))
    return { code: "aborted", message: "The call was aborted.", retryable: false };
  if (error instanceof APIConnectionError)
    return {
      code: "network",
      message: error.message,
      retryable: true,
      ...(error.cause !== undefined && { raw: String(error.cause) }),
    };
  if (error instanceof APIError) {
    const body = error.error as { error?: { code?: string; type?: string; message?: string } } | undefined;
    const code = classify(error.status, body?.error?.type, body?.error?.code, error.message);
    return {
      code,
      message: body?.error?.message ?? error.message,
      retryable: RETRYABLE.has(code),
      ...(error.status !== undefined && { status: error.status }),
      ...(error.error !== undefined && { raw: error.error }),
    };
  }
  return { code: "unknown", message: error instanceof Error ? error.message : String(error), retryable: false };
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limit", "unavailable", "network"]);

// Anthropic's own error types. A mid-stream `error` event carries one of these and no HTTP status.
const BY_TYPE: Record<string, ProviderErrorCode> = {
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "quota",
  rate_limit_error: "rate_limit",
  overloaded_error: "unavailable",
  api_error: "unavailable",
  timeout_error: "unavailable",
  not_found_error: "invalid_request",
  request_too_large: "invalid_request",
};

function classify(
  status: number | undefined,
  type: string | undefined,
  code: string | undefined,
  message: string,
): ProviderErrorCode {
  if (code?.startsWith("egress.")) return "invalid_request";
  if (/context window|prompt is too long|too many tokens/i.test(message)) return "context_window_exceeded";
  if (type && BY_TYPE[type]) return BY_TYPE[type];
  if (type === "invalid_request_error") return "invalid_request";
  switch (status) {
    case 400:
    case 413:
    case 422:
      return "invalid_request";
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
