import { defineAgent } from "@karmi/core";
import type { RecordingEntry, RecordingProvider } from "@karmi/core/testing";
import { routeError } from "./route-error";
import type { SuggestedPrompt } from "./scenarios";

/** The id of the transports scenario. */
export const TRANSPORTS = "transports";

/** The id of the Agent of the transports scenario. */
export const FRONT_DESK = "front-desk";

// The recording route finds the calls of this Agent by this text, which starts its Prompt.
const INSTRUCTIONS =
  "You work at the front desk of a small shop. Answer each question in two or three short sentences. You have no tools.";

/** The prompts that the scenario suggests. The operator can edit them. */
export const TRANSPORT_PROMPTS: SuggestedPrompt[] = [
  { label: "Opening hours", text: "When does the shop open on Saturday?" },
  { label: "Gift wrap", text: "Can you wrap a gift for me? Tell me the steps." },
];

/**
 * One guided request to a Thread route. In `path`, `{key}` is the Thread key of the scenario. The page sends the
 * request as it is and shows the answer next to `status`.
 */
export interface TransportRequest {
  label: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** False when the request goes without the access token. */
  token: boolean;
  /** The HTTP status of the answer. */
  status: number;
  /** The error code of the answer, for a status of 400 or more. */
  code?: string;
  /** What the answer shows. */
  shows: string;
}

/** The guided requests of the scenario, in the order that the page shows them. */
export const TRANSPORT_REQUESTS: readonly TransportRequest[] = [
  {
    label: "Read the Thread",
    method: "GET",
    path: "/threads/{key}",
    token: true,
    status: 200,
    shows: "The identity, the key and the status of the Thread. status.seq is the last seq of its event log.",
  },
  {
    label: "Read the events after seq 2",
    method: "GET",
    path: "/threads/{key}/events?after=2",
    token: true,
    status: 200,
    shows: "The stored events after seq 2 as JSON. A stream with ?after=2 sends the same events first.",
  },
  {
    label: "List the Threads of the Agent",
    method: "GET",
    path: `/threads?agent=${FRONT_DESK}`,
    token: true,
    status: 200,
    shows: "A summary of each Thread of the User with this Agent, the most recent first.",
  },
  {
    label: "Send no access token",
    method: "GET",
    path: "/threads/{key}",
    token: false,
    status: 401,
    code: "http.unauthorized",
    shows: "The authenticate function of the Playground returned null.",
  },
  {
    label: "Send a Turn that is not valid",
    method: "POST",
    path: "/threads/{key}/turns",
    body: { kind: "message", parts: "Hello" },
    token: true,
    status: 400,
    code: "http.badRequest",
    shows: "parts must be a list. The message tells the path of the field that is not valid.",
  },
  {
    label: "Answer an Approval that does not exist",
    method: "POST",
    path: "/threads/{key}/approvals/9999",
    body: { decision: "allow" },
    token: true,
    status: 404,
    code: "approval.notFound",
    shows: "No Approval request has the seq 9999.",
  },
  {
    label: "Open the Thread in the other Scope",
    method: "GET",
    path: "/threads/{key}?scope=sample-b",
    token: true,
    status: 404,
    code: "thread.notFound",
    shows: "The key names a Thread of the Scope sample-a. Through the Scope sample-b, the Thread does not exist.",
  },
];

/** Defines the Agent of the transports scenario. It has no Tools, thus each model can run it. */
export const frontDeskAgent = (model: string) =>
  defineAgent({
    agentId: FRONT_DESK,
    name: "Front desk",
    instructions: [{ text: INSTRUCTIONS }],
    model: { id: model },
  });

/** Returns the calls of the front desk Agent in `entries` as JSON Lines, the format of `recorder.toJSONL()`. */
export function frontDeskRecording(entries: readonly RecordingEntry[]): string {
  return entries
    .filter((entry) => entry.request.system?.includes(INSTRUCTIONS))
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join("");
}

/**
 * Answers `GET /api/recording` with the recorded calls of the front desk Agent as JSON Lines. Without a recording
 * Provider, it answers 404 with the command that starts one.
 */
export function recordingAnswer(recording: RecordingProvider | undefined): Response {
  if (!recording)
    return routeError(
      404,
      "playground.notRecording",
      "The Worker records no Provider calls. Start it with pnpm dev:record.",
    );
  return new Response(frontDeskRecording(recording.entries), {
    headers: { "content-type": "application/jsonl; charset=utf-8" },
  });
}
