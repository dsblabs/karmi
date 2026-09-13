import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
  LanguageModelV4TextPart,
  LanguageModelV4FilePart,
} from "@ai-sdk/provider";
import {
  loadedToolNames,
  mediaPlaceholder,
  hydrateMedia,
  type RequestMedia,
  type ContentBlock,
  type Message,
  type ProviderRequest,
  type ProviderCallOptions,
} from "@karmi/core";
import { InvalidRequestError } from "./errors";
import { z } from "zod";
import { metadataSchema, providerOptions } from "./options";

type AssistantPart = Extract<LanguageModelV4Message, { role: "assistant" }>["content"][number];

export function buildRequest(
  request: ProviderRequest,
  call: ProviderCallOptions,
  media: RequestMedia = new Map(),
): LanguageModelV4CallOptions {
  if (request.mcpServers?.length)
    throw new InvalidRequestError(
      `MCP execution: "provider" is only supported by the Anthropic adapter (servers: ${request.mcpServers.map((s) => s.name).join(", ")}).`,
    );
  const { reasoning, ...params } = request.params ?? {};
  const result: LanguageModelV4CallOptions = {
    ...params,
    prompt: [
      ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
      ...request.messages.map((value) => message(value, media)),
    ],
    abortSignal: call.signal,
    includeRawChunks: true,
    providerOptions: providerOptions(request),
  };
  if (reasoning) result.reasoning = reasoning === "off" ? "none" : reasoning;
  if (request.config.headers) result.headers = request.config.headers;
  if (request.tools) {
    // No native deferral here: a deferred definition is offered once the transcript has loaded it.
    const loaded = loadedToolNames(request.messages);
    result.tools = request.tools.flatMap(({ deferred, ...tool }) =>
      deferred && !loaded.has(tool.name) ? [] : [{ type: "function" as const, ...tool }],
    );
  }
  if (request.toolChoice)
    result.toolChoice =
      typeof request.toolChoice === "object"
        ? { type: "tool", toolName: request.toolChoice.name }
        : { type: request.toolChoice === "any" ? "required" : request.toolChoice };
  return result;
}

function message(value: Message, media: RequestMedia): LanguageModelV4Message {
  switch (value.role) {
    case "system":
      return value;
    case "user":
      return { role: "user", content: value.content.map((block) => userPart(block, media)) };
    case "assistant":
      return { role: "assistant", content: value.content.flatMap((block) => assistantPart(block, media)) };
    case "toolResult":
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            output: toolOutput(value, media),
          },
        ],
      };
  }
}

function userPart(block: ContentBlock, media: RequestMedia): LanguageModelV4TextPart | LanguageModelV4FilePart {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_reference") return { type: "text", text: `Tool "${block.name}" is now loaded.` };
  if (block.type === "media") {
    const encoded = media.get(block.media) ?? mediaPlaceholder(block.media);
    if (encoded.type === "text") return encoded;
    return {
      type: "file",
      data: { type: "data", data: encoded.data },
      mediaType: block.media.mimeType,
      ...(block.media.name && { filename: block.media.name }),
    };
  }
  throw new InvalidRequestError(`Unsupported user content: ${block.type}`);
}

function assistantPart(block: ContentBlock, media: RequestMedia): AssistantPart[] {
  const providerOptions = block.providerMetadata ? metadataSchema.parse(block.providerMetadata) : undefined;
  const meta = providerOptions ? { providerOptions } : {};
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text, ...meta }];
    case "thinking":
      return [{ type: "reasoning", text: block.text, ...meta }];
    case "tool_call":
      return [{ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.input, ...meta }];
    case "compaction":
      return [{ type: "text", text: block.summary, ...meta }];
    case "server_tool":
      return serverTool(block, meta, media);
    case "provider":
      return [];
    case "media":
    case "tool_reference":
      return [{ ...userPart(block, media), ...meta }];
  }
}

function serverTool(
  block: Extract<ContentBlock, { type: "server_tool" }>,
  meta: { providerOptions?: ReturnType<typeof metadataSchema.parse> },
  media: RequestMedia,
): AssistantPart[] {
  const parts: AssistantPart[] = [
    {
      type: "tool-call",
      toolCallId: block.id,
      toolName: block.name,
      input: block.input,
      providerExecuted: true,
      ...meta,
    },
  ];
  if (block.result) {
    const result = resultSchema.parse(hydrateMedia(block.result.raw, media));
    parts.push({
      type: "tool-result",
      toolCallId: block.id,
      toolName: block.name,
      output: { type: result.isError ? "error-json" : "json", value: result.result },
      ...(result.providerMetadata ? { providerOptions: result.providerMetadata } : {}),
    });
  }
  return parts;
}

const resultSchema = z.object({
  type: z.literal("tool-result"),
  result: z.json(),
  isError: z.boolean().optional(),
  providerMetadata: metadataSchema.optional(),
});

function toolOutput(value: Extract<Message, { role: "toolResult" }>, media: RequestMedia) {
  const parts = value.content.map((block) => userPart(block, media));
  if (parts.every((part) => part.type === "text"))
    return {
      type: value.isError ? ("error-text" as const) : ("text" as const),
      value: parts.map((part) => part.text).join("\n"),
    };
  return { type: "content" as const, value: parts };
}
