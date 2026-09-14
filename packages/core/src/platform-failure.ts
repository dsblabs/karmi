/**
 * Whether `error` is a platform failure: a Durable Object code-update reset or a retryable transport
 * error. Such a failure is recovered by retrying the Step and is never reported as a Provider or Tool
 * failure.
 */
export function isPlatformFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("retryable" in error && error.retryable === true) return true;
  return (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("Durable Object reset because its code was updated")
  );
}
