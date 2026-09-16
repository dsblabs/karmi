import type { ThreadEvent } from "@karmi/core";

/** How often an idle event stream sends a comment line so that proxies keep the connection open. */
const KEEP_ALIVE_MS = 20_000;

const encoder = new TextEncoder();

/**
 * Streams `events` as Server-Sent Events. Each event's `seq` is its `id`, so a browser `EventSource` resumes
 * from `Last-Event-ID` on reconnect, and its `data` is the same JSON a WebSocket frame carries. The stream
 * ends when the client disconnects or `signal` aborts.
 */
export function eventStream(events: AsyncIterable<ThreadEvent>, signal: AbortSignal): Response {
  const iterator = events[Symbol.asyncIterator]();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  const stop = () => {
    ended = true;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    void iterator.return?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), KEEP_ALIVE_MS);
      signal.addEventListener("abort", () => {
        if (ended) return;
        stop();
        controller.close();
      });
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done || ended) break;
          controller.enqueue(encoder.encode(`id: ${next.value.seq}\ndata: ${JSON.stringify(next.value)}\n\n`));
        }
        if (!ended) controller.close();
      } catch (error) {
        if (!ended) controller.error(error);
      } finally {
        stop();
      }
    },
    cancel: stop,
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
