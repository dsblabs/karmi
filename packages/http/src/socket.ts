import type { Granularity, Thread, ThreadEvent } from "@karmi/core";
import { decodeSocketFrame, type SocketFrame } from "./decode";
import { describeError, HttpError } from "./errors";

/** A frame the server sends: a Thread event verbatim, or the answer to a client frame. */
export type ServerFrame =
  | ThreadEvent
  /** The frame with `id` succeeded. `result` is what the Thread API returned, null for a void call. */
  | { type: "ack"; id?: string | number; result: unknown }
  /** The frame with `id` failed, or a frame could not be decoded when `id` is absent. */
  | { type: "error"; id?: string | number; error: { code: string; message: string } };

/** The replay position and detail level a socket streams from. */
export interface SocketOptions {
  /** The `seq` after which events are sent. Zero replays the whole log. */
  after: number;
  /** How much of each Turn is streamed, as on `thread.subscribe()`. */
  granularity: Granularity;
}

/**
 * Opens a WebSocket over `thread`. The server side replays events after `options.after`, then streams live
 * ones, and answers `send`, `steer`, `cancel` and `approve` frames with an `ack` or `error` frame. The
 * returned promise settles when the socket closes and is meant for `ctx.waitUntil`.
 */
export function openSocket(thread: Thread, options: SocketOptions): { response: Response; done: Promise<void> } {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const send = (frame: ServerFrame) => {
    try {
      server.send(JSON.stringify(frame));
    } catch {
      /* The socket closed while an event was in flight, and the close handler ends the stream. */
    }
  };
  const events = thread.subscribe(options)[Symbol.asyncIterator]();
  let open = true;
  server.addEventListener("message", (message) => {
    void handle(thread, message.data).then(send);
  });
  server.addEventListener("close", () => {
    open = false;
    void events.return?.();
  });
  server.addEventListener("error", () => {
    open = false;
    void events.return?.();
  });
  const done = (async () => {
    try {
      for (;;) {
        const next = await events.next();
        if (next.done || !open) break;
        send(next.value);
      }
    } catch (error) {
      const { message } = describeError(error).body.error;
      if (open) server.close(1011, message.slice(0, 120));
    }
  })();
  return { response: new Response(null, { status: 101, webSocket: client }), done };
}

async function handle(thread: Thread, data: string | ArrayBuffer): Promise<ServerFrame> {
  let frame: SocketFrame | undefined;
  try {
    if (typeof data !== "string") throw new HttpError(400, "http.badRequest", "Binary frames are not accepted.");
    frame = decodeSocketFrame(data);
    return { type: "ack", ...(frame.id !== undefined && { id: frame.id }), result: await dispatch(thread, frame) };
  } catch (error) {
    return { type: "error", ...(frame?.id !== undefined && { id: frame.id }), error: describeError(error).body.error };
  }
}

function dispatch(thread: Thread, frame: SocketFrame): Promise<unknown> {
  switch (frame.type) {
    case "send":
      return thread.send(frame.input, { steer: frame.steer });
    case "steer":
      return thread.send(frame.input, { steer: true });
    case "cancel":
      return thread.cancel().then(() => null);
    case "approve":
      return thread.approve(frame.seq, frame.answer).then(() => null);
  }
}
