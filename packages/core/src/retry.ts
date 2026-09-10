// The one retry helper karmi's internals share: bounded attempts, exponential backoff with jitter, and
// an AbortSignal that ends the wait at once. Callers decide what is retryable; nothing is by default.

export interface RetryOptions {
  retryable: (error: unknown) => boolean;
  /** Total attempts including the first; default 3. */
  attempts?: number;
  /** Base delay before the second attempt, doubled each time; default 500 ms. */
  delayMs?: number;
  signal?: AbortSignal;
}

export async function retry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.delayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !options.retryable(error)) throw error;
      await sleep(base * 2 ** (attempt - 1) * (0.5 + Math.random()), options.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
