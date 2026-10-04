import { z } from "zod";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ContentBlock } from "@karmi/core";
import { InvalidRequestError } from "./errors";

const usageSchema = z.object({
  server_tool_use_details: z.object({ web_search_requests: z.number().int().nonnegative() }),
});
const excerptSchema = z.object({ content: z.string() });

/** Collects OpenRouter citations and maps its aggregate search count to Provider Tool results. */
export class OpenRouterSearch {
  private sources = new Map<string, { url: string; title: string; content: string }>();

  /** Adds one citation returned by the SDK. */
  add(part: Extract<LanguageModelV4StreamPart, { type: "source" }>): void {
    if (part.sourceType !== "url") return;
    const excerpt = excerptSchema.safeParse(part.providerMetadata?.openrouter);
    this.sources.set(part.url, {
      url: part.url,
      title: part.title ?? "",
      content: excerpt.success ? excerpt.data.content : "",
    });
  }

  /** Reads the reported search count, or fails when citations have no usage count. */
  count(raw: unknown): number {
    const parsed = usageSchema.safeParse(raw);
    if (!parsed.success && this.sources.size)
      throw new InvalidRequestError("OpenRouter search results have no search usage count.");
    return parsed.success ? parsed.data.server_tool_use_details.web_search_requests : 0;
  }

  /** Returns at most the granted number of aggregate source results. */
  results(count: number): Extract<ContentBlock, { type: "server_tool" }>[] {
    const result = { sources: [...this.sources.values()] };
    return Array.from({ length: count }, () => {
      const id = `web_search_${crypto.randomUUID()}`;
      return {
        type: "server_tool",
        id,
        name: "web_search",
        input: {},
        raw: { type: "tool-call", toolCallId: id, toolName: "web_search", input: "{}", providerExecuted: true },
        result: {
          raw: { type: "tool-result", toolCallId: id, toolName: "web_search", result },
          summary: JSON.stringify(result),
        },
        providerMetadata: { openrouter: { searchResults: true } },
      };
    });
  }
}
