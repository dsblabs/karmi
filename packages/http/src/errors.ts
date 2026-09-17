import { KarmiError, type KarmiErrorCode } from "@karmi/core";

/** The code of a failure the transport itself raises, before or instead of a Thread API call. */
export type HttpErrorCode =
  "http.badRequest" | "http.unauthorized" | "http.notFound" | "http.methodNotAllowed" | "http.unsupportedMediaType";

/** A failure of the transport layer: a bad route, body or credential. It becomes a JSON error response. */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The body of every error response and every WebSocket `error` frame. */
export interface ErrorBody {
  error: { code: KarmiErrorCode | HttpErrorCode | "internal"; message: string };
}

// Every karmi code has an entry, so the compiler reports a new core code that this map does not place.
const STATUS: Record<KarmiErrorCode, number> = {
  "agent.conflict": 409,
  "agent.deleted": 404,
  "agent.id.invalid": 400,
  "agent.notFound": 404,
  "agent.spec.invalid": 400,
  "approval.invalid": 400,
  "approval.notFound": 404,
  "approval.resolved": 409,
  "bindings.missing": 500,
  "compaction.failed": 500,
  "compatibility.date": 500,
  "config.conflict": 409,
  "config.invalid": 400,
  "config.secret-value": 400,
  "credential.conflict": 409,
  "credential.readOnly": 409,
  "credential.ref.invalid": 400,
  "deliverer.invalid": 400,
  "deliverer.notFound": 404,
  "destroy.notFound": 404,
  "job.notFound": 404,
  "knowledge.invalid": 400,
  "knowledge.indexConflict": 409,
  "knowledge.inlineLimit": 400,
  "knowledge.busy": 409,
  "mcp.discovery.failed": 502,
  "mcp.oauth.failed": 502,
  "mcp.oauth.notOAuth": 400,
  "mcp.oauth.preRegistrationRequired": 400,
  "mcp.oauth.state": 400,
  "mcp.oauth.unconfigured": 500,
  "mcp.server.unknown": 404,
  "media.id.invalid": 400,
  "media.tooLarge": 413,
  "media.typeDenied": 415,
  "media.urlInvalid": 400,
  "thread.deleted": 404,
  "usage.invalid": 400,
  "name.duplicate": 409,
  "name.invalid": 400,
  "name.reserved": 400,
  "provider.adapter.unknown": 500,
  "provider.model.required": 400,
  "provider.profile.unknown": 400,
  "queue.unhandled": 500,
  "schedule.invalid": 400,
  "schedule.limit": 409,
  "schedule.notFound": 404,
  "ref.fragment.unknown": 400,
  "scope.destroyed": 409,
  "scope.limit": 409,
  "scope.id.invalid": 400,
  "scope.suspended": 409,
  "secrets.corrupt": 500,
  "secrets.exposed": 500,
  "secrets.kek.unknown": 500,
  "secrets.keyring.invalid": 500,
  "secrets.unavailable": 503,
  "test.recording-exhausted": 500,
  "test.recording-miss": 500,
  "test.script-exhausted": 500,
  "thread.busy": 409,
  "thread.exists": 409,
  "thread.id.invalid": 400,
  "thread.key.invalid": 404,
  "thread.mismatch": 404,
  "thread.notFound": 404,
  "thread.notParked": 409,
  "thread.seq.invalid": 400,
  "user.id.invalid": 400,
};

/** The HTTP status that reports a karmi error: 404 for a missing target, 409 for a state conflict, 400 for bad input. */
export function statusOf(code: KarmiErrorCode): number {
  return STATUS[code];
}

/** The status and JSON body that report `error`, whatever threw it. An unknown error is a 500 with no detail. */
export function describeError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof HttpError)
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof KarmiError)
    return { status: statusOf(error.code), body: { error: { code: error.code, message: error.message } } };
  return { status: 500, body: { error: { code: "internal", message: "Internal error." } } };
}

/** The JSON response that reports `error`. */
export function errorResponse(error: unknown): Response {
  const { status, body } = describeError(error);
  return Response.json(body, { status });
}
