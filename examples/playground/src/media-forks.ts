import { defineAgent, type MediaRef, type ThreadEvent } from "@karmi/core";

/** The id of the media and independent Thread Forks scenario and its Agent. */
export const FORKS = "forks";

/** The suggested prompt that sends a file to the Agent. */
export const FORKS_PROMPT = "Tell me what file I uploaded.";

/** Defines the Agent that receives the sample media before the operator forks its Thread. */
export const forksAgent = (model: string) =>
  defineAgent({
    agentId: FORKS,
    name: "Media guide",
    instructions: [
      {
        text: "Explain briefly what the attached file contains. If the model received only a file placeholder, say that its bytes were not available to this model.",
      },
    ],
    model: { id: model },
  });

/** The stored state of the media and Fork scenario. */
export type ForkScenarioData =
  { state: "original" } | { state: "forked"; forkedAt: number } | { state: "originalDeleted"; forkedAt: number };

/** Decodes the stored choices of the media and Fork scenario. */
export function decodeForkScenarioData(stored: string | undefined): ForkScenarioData {
  if (!stored) return { state: "original" };
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return { state: "original" };
    const forkedAt =
      "forkedAt" in value &&
      typeof value.forkedAt === "number" &&
      Number.isInteger(value.forkedAt) &&
      value.forkedAt > 0
        ? value.forkedAt
        : undefined;
    if (forkedAt === undefined || !("state" in value)) return { state: "original" };
    if (value.state === "forked") return { state: "forked", forkedAt };
    return value.state === "originalDeleted" ? { state: "originalDeleted", forkedAt } : { state: "original" };
  } catch {
    return { state: "original" };
  }
}

/** Returns each unique media reference carried by a message in the event log. */
export function referencedMedia(events: readonly ThreadEvent[]): MediaRef[] {
  const media = new Map<string, MediaRef>();
  for (const event of events) {
    if (event.type !== "turn.started" || event.input.kind !== "message") continue;
    for (const part of event.input.parts) if (part.type !== "text") media.set(part.media.id, part.media);
  }
  return [...media.values()];
}
