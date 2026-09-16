import { defineAgent, defineTool, type CatalogueInput } from "@karmi/core";
import { z } from "zod";

// Everything this Deployment defines in code. Agent Specs are plain data that reference these items by
// name, so a Platform can store and edit a Spec at runtime without deploying.

/** A sample Tool. Replace its body with a call to your own system. */
export const weather = defineTool({
  name: "weather",
  description: "The current weather in a city",
  input: z.object({ city: z.string().describe("The city to report on") }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `It is sunny in ${city}.`,
});

/** The sample Agent. */
export const concierge = defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "You are a hotel concierge. Answer in one or two sentences." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather"],
  // Rules are tried in order and the first match decides. No match means the call waits for an Approval.
  policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
});

/** The Catalogue this Deployment is assembled from. */
export const catalogue: CatalogueInput = { tools: [weather], agents: [concierge] };
