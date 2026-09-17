import * as z from "zod/mini";
import { KarmiError } from "./errors";
import type { Outcome } from "./outcome";
import type { ThreadAddress } from "./thread";
import type { ThreadDurableObject } from "./thread-do";
import type { Granularity, ThreadEventType } from "./thread-events";
import { decodeSocketFrame, ThreadProtocolError, type ServerFrame, type SocketFrame } from "./thread-protocol";

const Attachment = z.object({
  address: z.object({
    scope: z.string(),
    agent: z.string(),
    threadId: z.string(),
    user: z.optional(z.string()),
    create: z.boolean(),
  }),
  granularity: z.enum(["delta", "part", "turn"]),
});

/** The authority and detail level restored with a hibernating socket. */
export interface SocketAttachment {
  address: ThreadAddress;
  granularity: Granularity;
}

/** Decodes the internal upgrade or a hibernated socket's attachment. */
export function decodeSocketAttachment(value: unknown): SocketAttachment {
  const { address, granularity } = z.parse(Attachment, value);
  return {
    address: {
      scope: address.scope,
      agent: address.agent,
      threadId: address.threadId,
      create: address.create,
      ...(address.user !== undefined && { user: address.user }),
    },
    granularity,
  };
}

/** The event types omitted from both replay and live delivery at each detail level. */
export const excludedEventTypes: Record<Granularity, ThreadEventType[]> = {
  delta: [],
  part: ["message.delta"],
  turn: ["message.delta", "message.part"],
};

/** Answers a client frame against only the address bound at upgrade. */
export async function handleSocketFrame(
  host: ThreadDurableObject,
  address: ThreadAddress,
  data: string | ArrayBuffer,
): Promise<ServerFrame> {
  let frame: SocketFrame | undefined;
  try {
    if (typeof data !== "string") throw new ThreadProtocolError("Binary frames are not accepted.");
    frame = decodeSocketFrame(data);
    const result = await dispatch(host, address, frame);
    const id = frame.id !== undefined && { id: frame.id };
    return result.ok
      ? { type: "ack", ...id, result: result.value ?? null }
      : { type: "error", ...id, error: { code: result.code, message: result.message } };
  } catch (error) {
    return {
      type: "error",
      ...(frame?.id !== undefined && { id: frame.id }),
      error:
        error instanceof ThreadProtocolError || error instanceof KarmiError
          ? { code: error.code, message: error.message }
          : { code: "internal", message: "Internal error." },
    };
  }
}

function dispatch(
  host: ThreadDurableObject,
  address: ThreadAddress,
  frame: SocketFrame,
): Outcome<unknown> | Promise<Outcome<unknown>> {
  switch (frame.type) {
    case "send":
      return host.send(address, frame.input, frame.steer);
    case "steer":
      return host.send(address, frame.input, true);
    case "cancel":
      return host.cancel(address);
    case "approve":
      return host.approve(address, frame.seq, frame.answer);
  }
}
