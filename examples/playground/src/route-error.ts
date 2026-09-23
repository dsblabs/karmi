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
  | "playground.originalDeleted"
  | "schedule.invalid"
  | "schedule.limit"
  | "schedule.notFound";

/** Returns a Playground application error as a JSON response. */
export function routeError(status: number, code: RouteErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
