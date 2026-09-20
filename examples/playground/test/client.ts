import type { ThreadEvent } from "@karmi/core";
import { SELF } from "cloudflare:test";
import { TOKEN } from "./worker-options";

const BASE = "https://playground.test";

/** Sends one request to the test Worker. A `null` token sends no credential. */
export function api(token: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Reads the event log of a Thread through the public route. It checks only that the answer is a list. */
export async function events(key: string): Promise<ThreadEvent[]> {
  const value: unknown = await (await api(TOKEN, "GET", `/threads/${key}/events`)).json();
  if (!Array.isArray(value)) throw new Error("Not an event list.");
  return value as ThreadEvent[];
}
