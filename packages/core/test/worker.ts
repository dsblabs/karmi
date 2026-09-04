import { z } from "zod";
import { createKarmi, defineAgent, defineTool } from "../src/index.js";

const weather = defineTool({
  name: "weather",
  description: "Current weather for a city",
  input: z.object({ city: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `Sunny in ${city}`,
});

const concierge = defineAgent({ agentId: "concierge", name: "Concierge", instructions: [{ text: "Help the guest." }], model: { id: "anthropic/claude-sonnet-5" }, tools: ["weather"] });

export const karmi = createKarmi({ catalogue: { tools: [weather], agents: [concierge] }, defaults: { providers: { default: { adapter: "anthropic" } } }, providers: { anthropic: {} } });

export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === "/describe") return Response.json(karmi.catalogue.describe());
    return new Response("Not found", { status: 404 });
  },
  queue: karmi.queueHandler,
};
