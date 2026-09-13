import * as z from "zod/mini";

/** Opaque, Platform-minted Scope id (ADR-0001). */
export type ScopeId = string;
export type UserId = string;

export interface ThreadRef {
  id: string;
}

/** Binary content travels through karmi by reference; bytes never enter the event log. */
export const MediaRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  mimeType: z.string(),
  bytes: z.int().check(z.nonnegative()),
  name: z.optional(z.string()),
});
export type MediaRef = z.output<typeof MediaRefSchema>;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function isMediaRef(value: unknown): value is MediaRef {
  return z.safeParse(MediaRefSchema, value).success;
}
