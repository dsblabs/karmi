import { KarmiError } from "@karmi/core";

/** The error codes returned by Playground application routes. */
export type RouteErrorCode =
  | "bindings.missing"
  | "http.badRequest"
  | "http.notFound"
  | "http.unauthorized"
  | "playground.forkExists"
  | "playground.forkMissing"
  | "playground.forkPosition"
  | "playground.noJob"
  | "playground.noUsageBatch"
  | "playground.oauthUnavailable"
  | "playground.originalDeleted"
  | "playground.serverRegistered"
  | "schedule.invalid"
  | "schedule.limit"
  | "schedule.notFound";

/** Returns a Playground application error as a JSON response. */
export function routeError(status: number, code: RouteErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Returns a Framework error whose code starts with `prefix` as a 409 answer with its code and message. Throws each
 * other error again.
 */
export function conflictOf(caught: unknown, prefix: string): Response {
  if (!(caught instanceof KarmiError) || !caught.code.startsWith(prefix)) throw caught;
  return Response.json({ error: { code: caught.code, message: caught.message } }, { status: 409 });
}
