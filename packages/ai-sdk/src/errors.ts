import { APICallError, LoadAPIKeyError, TypeValidationError, UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { ZodError } from "zod";
import type { ProviderError, ProviderErrorCode } from "@karmi/core";

/** Thrown while building a request the AI SDK cannot express. It maps to the `invalid_request` code. */
export class InvalidRequestError extends Error {}

/** Maps an AI SDK error, a fetch error or a provider's plain JSON error body to a ProviderError with a code, message and retryable flag. */
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
  if (typeof error === "object" && error !== null && !(error instanceof Error)) return fromErrorBody(error);
  return { code: "unknown", message, retryable: false };
}

// Some providers, such as OpenRouter, send an in-stream error as the plain JSON body that the API sent,
// for example `{ code: 429, message }` or `{ error: { code, message } }`.
function fromErrorBody(error: object): ProviderError {
  const body = "error" in error && typeof error.error === "object" && error.error !== null ? error.error : error;
  const message = "message" in body && typeof body.message === "string" ? body.message : stringify(error);
  const status =
    httpStatus("code" in body ? body.code : undefined) ?? httpStatus("status" in body ? body.status : undefined);
  if (status === undefined) return { code: "unknown", message, retryable: false };
  const code = classify(status, message);
  return { code, message, retryable: code === "rate_limit" || code === "unavailable", status };
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

// JSON.stringify throws on a cyclic object or a BigInt, and an error mapper must never throw.
function stringify(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
