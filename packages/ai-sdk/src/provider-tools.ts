import { z } from "zod";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ProviderRequest } from "@karmi/core";
import { InvalidRequestError } from "./errors";

const pinsSchema = z.object({
  serverTools: z
    .array(z.object({ name: z.literal("web_search"), type: z.enum(["web_search", "web_search_preview"]) }))
    .optional(),
});

/** Adds granted Provider Tools and applies the remaining call budget. */
export function addProviderTools(
  request: ProviderRequest,
  params: LanguageModelV4CallOptions,
  provider: string,
): number | undefined {
  const grant = request.providerTools;
  const history = request.messages.some(
    (message) => message.role === "assistant" && message.content.some((block) => block.type === "server_tool"),
  );
  if (
    provider === "openai.responses" &&
    params.providerOptions?.openai?.store === false &&
    (grant?.tools.length || history)
  )
    throw new InvalidRequestError("OpenAI Provider Tool replay requires store: true.");
  if (!grant?.tools.length || grant.maxCalls === 0) return;
  if (provider.startsWith("openrouter") && grant.tools.every((name) => name === "web_search")) {
    const configured =
      openrouterSchema.parse({ ...request.config.providerOptions, ...request.providerOptions }.openrouter ?? {})
        .webSearch ?? {};
    const maxUses = Math.min(grant.maxCalls ?? Infinity, configured.max_uses ?? 1);
    params.tools = [
      ...(params.tools ?? []),
      {
        type: "provider",
        name: "web_search",
        id: "openrouter.web_search",
        args: { parameters: { ...configured, engine: configured.engine ?? "exa", max_uses: maxUses } },
      },
    ];
    return maxUses;
  }
  if (provider !== "openai.responses" || grant.tools.some((name) => name !== "web_search"))
    throw new InvalidRequestError("Provider Tools require OpenAI Responses or OpenRouter and only support web_search.");
  const pins = pinsSchema.parse(request.config.providerOptions?.openai ?? {});
  const pin = pins.serverTools?.find((tool) => tool.name === "web_search");
  params.tools = [
    ...(params.tools ?? []),
    {
      type: "provider",
      name: "web_search",
      id: pin?.type === "web_search_preview" ? "openai.web_search_preview" : "openai.web_search",
      args: {},
    },
  ];
  if (grant.maxCalls !== undefined) {
    const native = params.providerOptions?.openai ?? {};
    const configured = native.maxToolCalls;
    params.providerOptions = {
      ...params.providerOptions,
      openai: {
        ...native,
        maxToolCalls: Math.min(grant.maxCalls, typeof configured === "number" ? configured : Infinity),
      },
    };
  }
}

const openrouterSchema = z.object({
  webSearch: z
    .object({
      engine: z.enum(["exa", "parallel", "perplexity"]).optional(),
      max_uses: z.number().int().positive().optional(),
      max_results: z.number().int().min(1).max(20).optional(),
      max_total_results: z.number().int().positive().optional(),
      max_characters: z.number().int().min(1).max(100_000).optional(),
      allowed_domains: z.array(z.string()).optional(),
      excluded_domains: z.array(z.string()).optional(),
    })
    .optional(),
});
