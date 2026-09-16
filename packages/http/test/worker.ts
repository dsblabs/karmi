import { defineAgent, defineTool } from "@karmi/core";
import { createTestKarmi } from "@karmi/core/testing";
import { z } from "zod";
import { createHttpHandler, type Principal } from "../src/index";

const book = defineTool({
  name: "book",
  description: "Book a room",
  input: z.object({ room: z.number() }),
  execute: ({ room }) => `Booked ${room}`,
});
// Every call is allowed, so a Turn runs to completion without a human.
const concierge = defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [{ text: "Help the guest." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["book"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
});
// No Policy matches, so every call parks for an Approval.
const approver = defineAgent({
  agentId: "approver",
  name: "Approver",
  instructions: [{ text: "Ask before booking." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["book"],
  approvals: { timeout: 60 * 60 * 1000 },
});

export const { karmi, provider, scope } = createTestKarmi({ tools: [book], agents: [concierge, approver] });
export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;

/** The bearer tokens the test Worker accepts and who each one is. `service` has no User. */
export const principals: Record<string, Principal> = {
  alice: { scope: "test", user: "alice" },
  bob: { scope: "test", user: "bob" },
  service: { scope: "test" },
};

// A browser cannot set headers on a WebSocket, so the token may also arrive as a query parameter.
const authenticate = (request: Request): Principal | null => {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
  return (token && principals[token]) || null;
};

const http = createHttpHandler({ karmi, authenticate });

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) => http.fetch(request, env, ctx),
  queue: karmi.queueHandler,
};
