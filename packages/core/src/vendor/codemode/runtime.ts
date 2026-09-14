/// <reference lib="esnext.disposable" />
// Adapted from Cloudflare Codemode (MIT); see NOTICE.
export function disposeQuietly(resource: unknown): void {
  if (typeof resource !== "object" || resource === null || !(Symbol.dispose in resource)) return;
  const dispose: unknown = Reflect.get(resource, Symbol.dispose);
  if (typeof dispose !== "function") return;
  try {
    dispose.call(resource);
  } catch {
    /* Cleanup must not mask the result. */
  }
}
