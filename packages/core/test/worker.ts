import { z } from "zod";
import { defineAgent, defineFragment, defineTool } from "../src/index.js";
import { createTestKarmi } from "../src/testing/index.js";

const weather = defineTool({
  name: "weather",
  description: "Current weather for a city",
  input: z.object({ city: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `Sunny in ${city}`,
});

const guest = defineFragment({ name: "guest", args: z.object({ hotel: z.string() }), render: (ctx, { hotel }) => `You serve ${ctx.user ?? "the front desk"} at ${hotel}.` });

const concierge = defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "Help the guest." }, { fragment: "guest", args: { hotel: "The Grand" } }, { text: "You are Claude.", models: "anthropic/*" }],
  model: { id: "anthropic/claude-sonnet-5", fallbacks: ["anthropic/claude-haiku-4-5"] },
  tools: ["weather"],
});

export const { karmi, provider, scope } = createTestKarmi({ tools: [weather], fragments: [guest], agents: [concierge] });

export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === "/describe") return Response.json(karmi.catalogue.describe());
    return new Response("Not found", { status: 404 });
  },
  queue: karmi.queueHandler,
};
