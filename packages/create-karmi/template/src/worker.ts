import { anthropic } from "@karmi/anthropic";
import { createKarmi } from "@karmi/core";
import { createHttpHandler, type Principal } from "@karmi/http";
import { env } from "cloudflare:workers";
import { catalogue } from "./catalogue";
import { dailyBriefing, handleInbox } from "./triggers";

const karmi = createKarmi({
  catalogue,
  providers: { anthropic: anthropic() },
  // Every Scope inherits this layer and may only tighten it. The credential is a name, never a value:
  // store it with `scope.credentials.put("anthropic", value)`.
  defaults: {
    providers: { default: { adapter: "anthropic", models: ["anthropic/*"], credential: "scope:anthropic" } },
  },
});

/** The name of karmi's own Queue, as wrangler.jsonc declares it. */
const KARMI_QUEUE = "karmi-template-queue";
/** The Scopes the cron drives. A real Deployment reads these from wherever it mints Scopes. */
const SCOPES = ["demo"];

// karmi defines no credential scheme. Read whatever your requests carry and say who is behind them.
// Set the token with `wrangler secret put API_TOKEN`.
const authenticate = (request: Request): Principal | null => {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
  return token && token === env.API_TOKEN ? { scope: "demo", user: "demo-user" } : null;
};

const http = createHttpHandler({ karmi, authenticate });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;

export default {
  fetch: (request: Request, _env: unknown, ctx: ExecutionContext) => http.fetch(request, _env, ctx),
  // karmi's own Queue carries Deliverer work and Usage records. Every other queue is yours.
  queue: (batch: MessageBatch<unknown>, queueEnv: unknown, ctx: ExecutionContext) =>
    batch.queue === KARMI_QUEUE ? karmi.queueHandler(batch, queueEnv, ctx) : handleInbox(karmi, batch),
  scheduled: (event: ScheduledController, _scheduledEnv: unknown, ctx: ExecutionContext) =>
    ctx.waitUntil(dailyBriefing(karmi, SCOPES, event.scheduledTime)),
};
