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
