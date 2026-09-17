import type { Thread } from "./thread";
import type { ThreadEvent } from "./thread-events";

// Internal sockets carry only persisted Thread events because this subscriber never sends command frames.
function decodeEvent(data: string | ArrayBuffer): ThreadEvent {
  if (typeof data !== "string") throw new Error("A Thread event must be JSON text.");
  const event: ThreadEvent = JSON.parse(data);
  if (
    typeof event !== "object" ||
    event === null ||
    !Number.isSafeInteger(event.seq) ||
    event.seq < 1 ||
    !Number.isSafeInteger(event.turn) ||
    !Number.isFinite(event.at) ||
    typeof event.type !== "string"
  )
    throw new Error("Invalid internal Thread event envelope.");
  return event;
}

/** Streams a Thread's internal socket and releases it even when return interrupts a pending next call. */
export function subscribeSocket(
  open: Thread["socket"],
  options: Parameters<Thread["socket"]>[0],
): AsyncIterable<ThreadEvent> {
  return {
    [Symbol.asyncIterator]() {
      const controller = new AbortController();
      const events = stream(open, options, controller.signal);
      return {
        next: () => events.next(),
        return: async () => {
          controller.abort();
          return events.return();
        },
      };
    },
  };
}

async function* stream(
  open: Thread["socket"],
  options: Parameters<Thread["socket"]>[0],
  signal: AbortSignal,
): AsyncGenerator<ThreadEvent, void> {
  let after = options?.after;
  while (!signal.aborted) {
    const response = await open({ ...options, ...(after !== undefined && { after }) });
    const socket = response.webSocket;
    if (!socket) throw new Error("Thread upgrade returned no socket.");
    after ??= Number(response.headers.get("x-karmi-seq"));
    const queue: ThreadEvent[] = [];
    let wake = () => {};
    let closed = false;
    let terminal = false;
    let failure: unknown;
    const stop = () => {
      closed = true;
      wake();
    };
    socket.addEventListener("message", (event) => {
      try {
        queue.push(decodeEvent(event.data));
      } catch (error) {
        failure = error;
        closed = true;
      }
      wake();
    });
    socket.addEventListener("close", (event) => {
      terminal = event.code === 4004;
      stop();
    });
    socket.addEventListener("error", stop);
    signal.addEventListener("abort", stop, { once: true });
    socket.accept();
    try {
      while (!signal.aborted) {
        if (failure !== undefined) throw failure;
        const batch = queue.splice(0);
        for (const event of batch) {
          after = event.seq;
          yield event;
        }
        if (failure !== undefined) throw failure;
        if (queue.length > 0) continue;
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", stop);
      socket.close(1000, "Subscriber stopped.");
    }
    if (terminal) return;
  }
}
