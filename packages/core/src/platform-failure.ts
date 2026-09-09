/** Runtime resets and retryable DO transport failures must not masquerade as Provider/Tool failures. */
export function isPlatformFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("retryable" in error && error.retryable === true) return true;
  return "message" in error && typeof error.message === "string" && error.message.includes("Durable Object reset because its code was updated");
}
