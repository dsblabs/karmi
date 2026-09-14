import * as z from "zod/mini";

/** The opaque id of a Scope. The Platform mints it and karmi never interprets it (ADR-0001). */
export type ScopeId = string;
/** The opaque id of a User within a Scope. The Platform mints it. */
export type UserId = string;

/** A reference to a Thread by id. */
export interface ThreadRef {
  id: string;
}

/**
 * The schema of a MediaRef, the reference by which binary content travels through karmi. Bytes never enter the
 * event log.
 */
export const MediaRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  mimeType: z.string(),
  bytes: z.int().check(z.nonnegative()),
  name: z.optional(z.string()),
});
/** A reference to binary content stored in R2 under its Thread. */
export type MediaRef = z.output<typeof MediaRefSchema>;

/** A structured logger with one method per level. Each call takes a message and optional fields. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Whether `value` has the MediaRef shape. */
export function isMediaRef(value: unknown): value is MediaRef {
  return z.safeParse(MediaRefSchema, value).success;
}
