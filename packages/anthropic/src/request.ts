import {
  hydrateMedia,
  mediaPlaceholder,
  mediaKind,
  type RequestMedia,
  type ContentBlock,
  type Message,
  type ProviderRequest,
  type ToolDefinition,
} from "@karmi/core";
import type {
  BetaCacheControlEphemeral,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaServerToolUseBlockParam,
  BetaTextBlockParam,
  BetaImageBlockParam,
  BetaTool,
  BetaToolChoice,
  BetaToolReferenceBlockParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaMCPToolset,
  BetaRequestMCPServerURLDefinition,
  MessageCountTokensParams,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DEFAULT_MAX_TOKENS } from "./models";
import { anthropicOptions, type AnthropicOptions } from "./options";

// karmi's plain-JSON request → the Messages API body. Reserved block families (`compaction`, server-tool
// results, `provider`) go back on the wire byte-exact; the replay rules already decided they belong here.

const BETAS = {
  fallbacks: "server-side-fallback-2026-07-01",
  compaction: "compact-2026-01-12",
  mcp: "mcp-client-2025-11-20",
  taskBudget: "task-budgets-2026-03-13",
} as const;
/** The lowest `input_tokens` trigger the API accepts; a `compact` request asks for the earliest possible one. */
const COMPACT_TRIGGER_MIN = 50_000;

/** Block param types that accept `cache_control`. */
const CACHEABLE = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "server_tool_use",
  "compaction",
  "tool_reference",
]);

export function buildParams(request: ProviderRequest, media: RequestMedia = new Map()): MessageCreateParamsBase {
  const options = anthropicOptions(request);
  const cache = options.cache === false ? undefined : cacheControl(options.cache?.ttl);
  const messages = toMessages(request.messages, cache, media);
  const tools = toTools(request, options, cache);
  const params: MessageCreateParamsBase = {
    model: request.model,
    max_tokens: request.params?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (request.system !== undefined)
    params.system = [
      cache ? { type: "text", text: request.system, cache_control: cache } : { type: "text", text: request.system },
    ];
  if (tools.length > 0) params.tools = tools;
  const choice = toolChoice(request.toolChoice, request.parallelToolCalls);
  if (choice) params.tool_choice = choice;
  if (request.params?.temperature !== undefined) params.temperature = request.params.temperature;
  if (request.params?.topP !== undefined) params.top_p = request.params.topP;

  const reasoning = request.params?.reasoning;
  const thinking =
    options.thinking ??
    (reasoning === "off" ? { type: "disabled" as const } : reasoning ? { type: "adaptive" as const } : undefined);
  if (thinking) params.thinking = thinking;
  const effort = options.effort ?? (reasoning && reasoning !== "off" ? reasoning : undefined);
  if (effort || options.taskBudget)
    params.output_config = {
      ...(effort && { effort }),
      ...(options.taskBudget && { task_budget: options.taskBudget }),
    };
  if (options.fallbacks) params.fallbacks = options.fallbacks;
  if (options.contextManagement) params.context_management = options.contextManagement;
  // A Harness `compact` wins over any configured edits: it wants the block back now, and nothing else.
  if (request.compact)
    params.context_management = {
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: COMPACT_TRIGGER_MIN },
          pause_after_compaction: true,
          ...(request.compact.instructions !== undefined && { instructions: request.compact.instructions }),
        },
      ],
    };
  const connector = mcpConnector(request);
  if (options.mcpServers || connector.length > 0)
    params.mcp_servers = [...(options.mcpServers ?? []), ...connector.map(({ server }) => server)];

  const betas = collectBetas(request, options, messages);
  if (betas.length > 0) params.betas = betas;
  return params;
}

/** The subset of a request `count_tokens` accepts. */
export function countTokensParams(request: ProviderRequest, media: RequestMedia = new Map()): MessageCountTokensParams {
  const {
    model,
    messages,
    system,
    tools,
    tool_choice,
    thinking,
    context_management,
    mcp_servers,
    betas,
    output_config,
  } = buildParams(request, media);
  return {
    model,
    messages,
    ...(system && { system }),
    ...(tools && { tools }),
    ...(tool_choice && { tool_choice }),
    ...(thinking && { thinking }),
    ...(context_management && { context_management }),
    ...(mcp_servers && { mcp_servers }),
    ...(output_config && { output_config }),
    ...(betas && { betas }),
  };
}

function collectBetas(request: ProviderRequest, options: AnthropicOptions, messages: BetaMessageParam[]): string[] {
  const betas = new Set<string>(options.betas);
  // A profile header lists betas too; folded in here because a request-level list would replace it.
  for (const beta of request.config.headers?.["anthropic-beta"]?.split(",") ?? [])
    if (beta.trim()) betas.add(beta.trim());
  if (options.fallbacks) betas.add(BETAS.fallbacks);
  if (options.mcpServers || request.mcpServers?.length) betas.add(BETAS.mcp);
  if (options.taskBudget) betas.add(BETAS.taskBudget);
  const compacts =
    request.compact !== undefined ||
    options.contextManagement?.edits?.some((edit) => edit.type === "compact_20260112") ||
    messages.some(
      (message) => Array.isArray(message.content) && message.content.some((block) => block.type === "compaction"),
    );
  if (compacts) betas.add(BETAS.compaction);
  return [...betas];
}

function cacheControl(ttl?: "5m" | "1h"): BetaCacheControlEphemeral {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * karmi's `execution: "provider"` servers on Anthropic's MCP connector: one `mcp_servers` entry with the
 * registry's token, and one `mcp_toolset` carrying the allow/deny lists as per-tool enablement.
 */
function mcpConnector(
  request: ProviderRequest,
): { server: BetaRequestMCPServerURLDefinition; toolset: BetaMCPToolset }[] {
  return (request.mcpServers ?? []).map(({ name, url, authorization, allow, deny }) => {
    const configs: NonNullable<BetaMCPToolset["configs"]> = {};
    for (const tool of allow ?? []) configs[tool] = { enabled: true };
    for (const tool of deny ?? []) configs[tool] = { enabled: false };
    return {
      server: { type: "url", name, url, ...(authorization && { authorization_token: authorization.expose() }) },
      toolset: {
        type: "mcp_toolset",
        mcp_server_name: name,
        ...(allow && { default_config: { enabled: false } }),
        ...(Object.keys(configs).length > 0 && { configs }),
      },
    };
  });
}

function toTools(
  request: ProviderRequest,
  options: AnthropicOptions,
  cache: BetaCacheControlEphemeral | undefined,
): BetaToolUnion[] {
  // Deferred definitions go last: the API strips them from the cached prefix, and they take no cache_control.
  const ordered = (request.tools ?? []).toSorted((a, b) => Number(a.deferred === true) - Number(b.deferred === true));
  const out: BetaToolUnion[] = ordered.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as BetaTool["input_schema"],
    ...(tool.strict && { strict: true }),
    ...(tool.deferred && { defer_loading: true }),
  }));
  if (options.serverTools) out.push(...options.serverTools);
  out.push(...mcpConnector(request).map(({ toolset }) => toolset));
  const last = out.filter((tool): tool is BetaTool => "input_schema" in tool && !tool.defer_loading).at(-1);
  if (cache && last) last.cache_control = cache;
  return out;
}

function toolChoice(choice: ProviderRequest["toolChoice"], parallel: boolean | undefined): BetaToolChoice | undefined {
  const serial = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined) return parallel === false ? { type: "auto", ...serial } : undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "auto" || choice === "any") return { type: choice, ...serial };
  return { type: "tool", name: choice.name, ...serial };
}

// Consecutive user-side messages (Tool results, then the next User message) merge into one user turn with
// the results first, which is the only order Anthropic accepts.
function toMessages(
  messages: Message[],
  cache: BetaCacheControlEphemeral | undefined,
  media: RequestMedia,
): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  const push = (role: BetaMessageParam["role"], content: BetaContentBlockParam[]) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user":
        push(
          "user",
          message.content.flatMap((block) => userBlock(block, media)),
        );
        break;
      case "assistant":
        push(
          "assistant",
          message.content.flatMap((block) => assistantBlock(block, media)),
        );
        break;
      case "toolResult": {
        // A load point carries only its references; the API rejects them mixed with text, so any text follows as siblings.
        const references: BetaToolReferenceBlockParam[] = message.content.flatMap((block) =>
          block.type === "tool_reference" ? [{ type: "tool_reference", tool_name: block.name }] : [],
        );
        const text = message.content.flatMap((block) => userBlock(block, media));
        const content: BetaToolResultBlockParam["content"] = references.length > 0 ? references : text;
        push("user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            is_error: message.isError,
            ...(content.length > 0 && { content }),
          },
          ...(references.length > 0 ? text : []),
        ]);
        break;
      }
    }
  }
  const last = out[out.length - 1];
  if (cache && last && Array.isArray(last.content)) {
    const block = last.content[last.content.length - 1];
    if (block && CACHEABLE.has(block.type))
      (block as { cache_control?: BetaCacheControlEphemeral }).cache_control = cache;
  }
  return out;
}

type UserBlock = BetaTextBlockParam | BetaImageBlockParam | Extract<BetaContentBlockParam, { type: "document" }>;
function userBlock(block: ContentBlock, media: RequestMedia): UserBlock[] {
  if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
  if (block.type !== "media") return [];
  const encoded = media.get(block.media) ?? mediaPlaceholder(block.media);
  if (encoded.type === "text") return [encoded];
  const { mimeType } = block.media;
  if (mimeType === "application/pdf")
    return [{ type: "document", source: { type: "base64", media_type: mimeType, data: encoded.data } }];
  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/gif" || mimeType === "image/webp")
    return [{ type: "image", source: { type: "base64", media_type: mimeType, data: encoded.data } }];
  // The SDK types only list known modalities/MIMEs. Unknown models get the base64 source
  // envelope optimistically; a definite capability denial was already replaced by text.
  return [
    { type: mediaKind(mimeType), source: { type: "base64", media_type: mimeType, data: encoded.data } } as UserBlock,
  ];
}

function assistantBlock(block: ContentBlock, media: RequestMedia): BetaContentBlockParam[] {
  switch (block.type) {
    case "media":
      return userBlock(block, media);
    case "text":
      return block.text.trim() ? [{ type: "text", text: block.text }] : [];
    case "thinking":
      if (block.redacted) return block.signature ? [{ type: "redacted_thinking", data: block.signature }] : [];
      // An unsigned thinking block cannot be replayed; the replay rules already kept only same-model ones.
      return block.signature ? [{ type: "thinking", thinking: block.text, signature: block.signature }] : [];
    case "tool_call":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "server_tool":
      return [
        // Replayed only to the provider that produced it, so the name is one Anthropic itself emitted.
        {
          type: "server_tool_use",
          id: block.id,
          name: block.name as BetaServerToolUseBlockParam["name"],
          input: block.input,
        },
        ...(block.result ? [hydrateMedia(block.result.raw, media) as BetaContentBlockParam] : []),
      ];
    case "compaction":
      return block.raw
        ? [hydrateMedia(block.raw, media) as BetaContentBlockParam]
        : [{ type: "text", text: block.summary }];
    case "provider":
      return [hydrateMedia(block.raw, media) as BetaContentBlockParam];
    default:
      return [];
  }
}
