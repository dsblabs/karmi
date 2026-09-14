import type { ApprovalAnswer, Granularity, TurnInput } from "@karmi/core";
import * as z from "zod/mini";
import { HttpError } from "./errors";

// Every shape a client may post is decoded here, once, and nowhere else. Media Parts are not accepted as
// JSON: bytes reach a Thread only through a multipart upload, so no client can name another Thread's media.

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const MessageInput = z.object({
  kind: z.literal("message"),
  parts: z.array(TextPart).check(z.minLength(1)),
  skill: z.optional(z.string()),
  channelRef: z.optional(z.unknown()),
});
const EventInput = z.object({
  kind: z.literal("event"),
  type: z.string(),
  payload: z.unknown(),
  channelRef: z.optional(z.unknown()),
});
const TurnInputSchema = z.discriminatedUnion("kind", [MessageInput, EventInput]);
const Steer = { steer: z.optional(z.boolean()) };
const TurnRequestSchema = z.discriminatedUnion("kind", [z.extend(MessageInput, Steer), z.extend(EventInput, Steer)]);
const ApprovalAnswerSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  reason: z.optional(z.string()),
  remember: z.optional(z.boolean()),
  by: z.optional(z.string()),
});
const CreateThreadSchema = z.object({ agent: z.string(), threadId: z.optional(z.string()) });
const CompactSchema = z.object({ instructions: z.optional(z.string()) });
const Correlated = { id: z.optional(z.union([z.string(), z.number()])) };
const FrameSchema = z.discriminatedUnion("type", [
  z.object({ ...Correlated, type: z.literal("send"), input: TurnInputSchema, steer: z.optional(z.boolean()) }),
  z.object({ ...Correlated, type: z.literal("steer"), input: TurnInputSchema }),
  z.object({ ...Correlated, type: z.literal("cancel") }),
  z.object({ ...Correlated, type: z.literal("approve"), seq: z.int(), answer: ApprovalAnswerSchema }),
]);

/** A request to open a Thread: the Agent and, optionally, the `threadId` to use instead of a random one. */
export type CreateThreadRequest = z.infer<typeof CreateThreadSchema>;
/** A JSON Turn request: a text-only `TurnInput` plus `steer`. */
export type TurnRequest = { input: TurnInput; steer: boolean };
/** One frame a WebSocket client sends. `id` is echoed on the `ack` or `error` frame that answers it. */
export type SocketFrame = { id?: string | number } & (
  | { type: "send"; input: TurnInput; steer: boolean }
  | { type: "steer"; input: TurnInput }
  | { type: "cancel" }
  | { type: "approve"; seq: number; answer: ApprovalAnswer }
);

function parse<S extends z.ZodMiniType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = z.safeParse(schema, value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  throw new HttpError(
    400,
    "http.badRequest",
    `Invalid ${what}${path ? ` at ${path}` : ""}: ${issue?.message ?? "malformed"}.`,
  );
}

// The parsed objects carry `undefined` for absent optional fields, which the Thread API's exact optional
// types reject, so each decoder rebuilds the value with only the fields that were present.
function toTurnInput(parsed: z.output<typeof TurnInputSchema>): TurnInput {
  const channelRef = parsed.channelRef !== undefined && { channelRef: parsed.channelRef };
  if (parsed.kind === "event") return { kind: "event", type: parsed.type, payload: parsed.payload, ...channelRef };
  return {
    kind: "message",
    parts: parsed.parts,
    ...(parsed.skill !== undefined && { skill: parsed.skill }),
    ...channelRef,
  };
}

/** Decodes the body of `POST /threads`. Throws a 400 `HttpError` for anything else. */
export function decodeCreateThread(body: unknown): CreateThreadRequest {
  return parse(CreateThreadSchema, body, "thread request");
}

/** Decodes a JSON Turn body: a `TurnInput` with an optional `steer` flag. Throws a 400 `HttpError` for anything else. */
export function decodeTurnRequest(body: unknown): TurnRequest {
  const parsed = parse(TurnRequestSchema, body, "turn");
  return { input: toTurnInput(parsed), steer: parsed.steer === true };
}

/** Decodes an `ApprovalAnswer`. Throws a 400 `HttpError` for anything else. */
export function decodeApprovalAnswer(body: unknown): ApprovalAnswer {
  const parsed = parse(ApprovalAnswerSchema, body, "approval answer");
  return {
    decision: parsed.decision,
    ...(parsed.reason !== undefined && { reason: parsed.reason }),
    ...(parsed.remember !== undefined && { remember: parsed.remember }),
    ...(parsed.by !== undefined && { by: parsed.by }),
  };
}

/** Decodes the optional body of `POST /threads/:key/compact`. Throws a 400 `HttpError` for anything else. */
export function decodeCompact(body: unknown): { instructions?: string } {
  const parsed = parse(CompactSchema, body ?? {}, "compact request");
  return parsed.instructions === undefined ? {} : { instructions: parsed.instructions };
}

// The object form pins the list to core's `Granularity`, so a new value there fails to compile here.
const GRANULARITIES: Record<Granularity, true> = { delta: true, part: true, turn: true };

/** Whether `value` names a subscription granularity. */
export function isGranularity(value: string): value is Granularity {
  return Object.hasOwn(GRANULARITIES, value);
}

/** Parses JSON text a client sent as `what`. Throws a 400 `HttpError` when it is not JSON. */
export function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "http.badRequest", `The ${what} is not valid JSON.`);
  }
}

/** Decodes one WebSocket frame from its JSON text. Throws a 400 `HttpError` for anything else. */
export function decodeSocketFrame(text: string): SocketFrame {
  const frame = parse(FrameSchema, parseJsonText(text, "frame"), "frame");
  const id = frame.id !== undefined && { id: frame.id };
  switch (frame.type) {
    case "send":
      return { ...id, type: "send", input: toTurnInput(frame.input), steer: frame.steer === true };
    case "steer":
      return { ...id, type: "steer", input: toTurnInput(frame.input) };
    case "cancel":
      return { ...id, type: "cancel" };
    case "approve":
      return { ...id, type: "approve", seq: frame.seq, answer: decodeApprovalAnswer(frame.answer) };
  }
}
