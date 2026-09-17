import * as z from "zod/mini";
import { HttpError } from "./errors";

export { decodeTurnRequest, decodeApprovalAnswer, isGranularity, parseJsonText } from "@karmi/core";
export type { SocketFrame, TurnRequest } from "@karmi/core";
const CreateThreadSchema = z.object({ agent: z.string(), threadId: z.optional(z.string()) });
const CompactSchema = z.object({ instructions: z.optional(z.string()) });
/** A request to open a Thread with an optional caller-chosen id. */
export type CreateThreadRequest = z.infer<typeof CreateThreadSchema>;

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

/** Decodes the body of `POST /threads`. Throws a 400 `HttpError` for anything else. */
export function decodeCreateThread(body: unknown): CreateThreadRequest {
  return parse(CreateThreadSchema, body, "thread request");
}

/** Decodes the optional body of `POST /threads/:key/compact`. Throws a 400 `HttpError` for anything else. */
export function decodeCompact(body: unknown): { instructions?: string } {
  const parsed = parse(CompactSchema, body ?? {}, "compact request");
  return parsed.instructions === undefined ? {} : { instructions: parsed.instructions };
}
