/** Opaque, Platform-minted Scope id (ADR-0001). */
export type ScopeId = string;
export type UserId = string;

export interface ThreadRef {
  id: string;
}

/** Binary content travels through karmi by reference; bytes never enter the event log. */
export interface MediaRef {
  id: string;
  key: string;
  mimeType: string;
  bytes: number;
  name?: string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function isMediaRef(value: unknown): value is MediaRef {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    "key" in value &&
    "mimeType" in value &&
    "bytes" in value &&
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    (!("name" in value) || value.name === undefined || typeof value.name === "string")
  );
}
