import { defineAgent, type MemoryProfileProperty } from "@karmi/core";
import { z } from "zod";
import { decodeSample } from "./sample-data";

/** The id of the Memory and Scope isolation scenario. */
export const MEMORY = "memory";
/** The id of the Agent of the scenario. */
export const CONCIERGE = "concierge";

/**
 * The Profile fields of the Agent, as a JSON Schema object. The Harness checks each `remember` call against them
 * and refuses a field that the Agent does not declare. The page shows them next to the stored Profile.
 */
export const PROFILE_FIELDS: Record<string, MemoryProfileProperty> = {
  roast: { type: "string", enum: ["light", "medium", "dark"], description: "The roast that the customer prefers." },
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const CONCIERGE_PROMPTS = [
  { label: "Remember", text: "I like a dark roast, and I collect my order on Fridays. Please remember that." },
  { label: "Ask", text: "Which roast do I like, and when do I collect my order?" },
  { label: "Search the Notes", text: "Search your notes for my collection day." },
];

/** The schema of the sample data of one Scope: how many Threads the scenario opened since the last reset. */
const memoryDataSchema = z.object({ threads: z.number().int().positive() });

/** The sample data of the scenario in one Scope. */
export type MemoryData = z.infer<typeof memoryDataSchema>;

/** Decodes the stored sample data. Data that is absent or not valid gives one Thread. */
export const decodeMemoryData = (data: string | undefined): MemoryData =>
  decodeSample(memoryDataSchema, { threads: 1 }, data);

/**
 * Defines the Agent for the model that setup selected. The `memory` block gives it the built-in Tools `remember`
 * and `recall`, and a Memory Fragment with the Profile and the recent Notes of the User at the start of each Turn.
 */
export const conciergeAgent = (model: string) =>
  defineAgent({
    agentId: CONCIERGE,
    name: "Coffee shop concierge",
    instructions: [
      {
        text: "You are the concierge of a small coffee shop. When the customer tells you a preference, save it with the remember tool: put the roast in the profile field roast, and put each other detail in one short note. Then confirm in one sentence. When the customer asks what you know, answer from the Memory section of these instructions in one sentence. When the Memory section knows nothing, say that you do not know their preferences yet. When the customer asks you to search your notes, use the recall tool and report what it found.",
      },
    ],
    model: { id: model },
    memory: { profile: { properties: PROFILE_FIELDS } },
  });
