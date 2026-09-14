// The one retry helper karmi's internals share. It bounds the attempts, backs off exponentially with
// jitter, and stops waiting as soon as the AbortSignal fires. Nothing is retryable unless the caller
// says so.

/** How `retry` treats failures. */
export interface RetryOptions {
  /** Whether a thrown error may be retried. */
  retryable: (error: unknown) => boolean;
  /** The total attempts including the first. Defaults to 3. */
  attempts?: number;
  /** The base delay before the second attempt, doubled each time. Defaults to 500 ms. */
  delayMs?: number;
  /** Ends a pending wait at once and makes the next attempt throw. */
  signal?: AbortSignal;
}

/**
 * Retries `run` up to `attempts` times with exponential backoff and jitter. Nothing is retryable
 * unless `retryable` says so.
 */
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
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
