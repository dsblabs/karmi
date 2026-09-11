import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Usage, UsageCost, StopReason } from "@karmi/core";
import { z } from "zod";

type Finish = Extract<LanguageModelV4StreamPart, { type: "finish" }>;
const costValue = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().nonnegative());
const gatewaySchema = z.object({ cost: costValue, byok: z.boolean().optional() });
const routerSchema = z.object({
  cost: costValue,
  is_byok: z.boolean().optional(),
  cost_details: z.object({ upstream_inference_cost: costValue.nullish() }).optional(),
});

export function usage(part: Finish, provider: string): Usage {
  const tokens = part.usage;
  const result: Usage = {
    input: tokens.inputTokens.total ?? 0,
    output: tokens.outputTokens.total ?? 0,
    cacheRead: tokens.inputTokens.cacheRead ?? 0,
    cacheWrite: tokens.inputTokens.cacheWrite ?? 0,
  };
  if (tokens.outputTokens.reasoning !== undefined) result.reasoning = tokens.outputTokens.reasoning;
  const cost = reportedCost(part, provider);
  if (cost) result.cost = cost;
  return result;
}

function reportedCost(part: Finish, provider: string): UsageCost | undefined {
  const gateway = gatewaySchema.safeParse(part.providerMetadata?.gateway);
  if (gateway.success)
    return {
      amount: gateway.data.cost,
      currency: "USD",
      source: "vercel-gateway",
      basis: "billed",
      ...(gateway.data.byok === undefined ? {} : { byok: gateway.data.byok }),
    };
  if (!provider.startsWith("openrouter")) return;
  const router = routerSchema.safeParse(part.usage.raw);
  if (!router.success) return;
  const result: UsageCost = { amount: router.data.cost, currency: "USD", source: "openrouter", basis: "billed" };
  if (router.data.is_byok !== undefined) result.byok = router.data.is_byok;
  const upstream = router.data.cost_details?.upstream_inference_cost;
  if (upstream != null) result.upstream = upstream;
  return result;
}

export function stopReason(part: Finish): StopReason {
  if (part.finishReason.raw === "pause_turn") return "pause_turn";
  if (part.finishReason.raw === "model_context_window_exceeded") return "context_window_exceeded";
  switch (part.finishReason.unified) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "refusal";
    case "error":
      return "error";
    default:
      return "error";
  }
}
