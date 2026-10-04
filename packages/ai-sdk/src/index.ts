import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  prepareMedia,
  ingestProviderEvent,
  type Provider,
  type ProviderCallOptions,
  type ProviderConfig,
  type ModelCapabilities,
} from "@karmi/core";
import { mapProviderOptions } from "./options";
import { addCacheBreakpoints, type CacheOption } from "./cache";
import { addProviderTools } from "./provider-tools";
import { buildRequest } from "./request";
import { mapStream } from "./stream";
import { toProviderError } from "./errors";

/** What a `ModelFactory` receives per call: the call options plus the model id and Provider profile. */
export interface ModelFactoryContext extends ProviderCallOptions {
  modelId: string;
  /** The Provider profile the call runs under. */
  config: ProviderConfig;
}
/** Builds the AI SDK language model for one call. */
export type ModelFactory = (context: ModelFactoryContext) => LanguageModelV4 | PromiseLike<LanguageModelV4>;

export type { CacheOption } from "./cache";

/** The options of `aiSdk`. */
export interface AiSdkOptions {
  /**
   * Prompt-cache breakpoints on the system prompt, the last Tool and the last message. On by default with the
   * 5-minute TTL. `false` turns them off. Anthropic models, directly or through OpenRouter or a gateway, read
   * them. Providers that cache automatically, such as OpenAI and Google, ignore them.
   */
  cache?: CacheOption;
  /**
   * The capabilities that you know for a model, for example `{ contextWindow: 128_000 }`. Each value you give
   * wins over what the adapter learns from the model. Without a `contextWindow`, Compaction assumes 200,000
   * tokens unless the Agent Spec sets `context.window`.
   */
  capabilities?: (modelId: string) => Partial<ModelCapabilities> | undefined;
}

const UNKNOWN: ModelCapabilities = { image: "unknown", audio: "unknown", video: "unknown", pdf: "unknown" };

/**
 * A Provider backed by an AI SDK language model. Construct the SDK client inside `model` so each call uses
 * its Scope's fetch and credentials.
 */
export function aiSdk(model: ModelFactory, options: AiSdkOptions = {}): Provider {
  const learned = new Map<string, ModelCapabilities>();
  const resolve = (modelId: string): ModelCapabilities => ({
    ...(learned.get(modelId) ?? UNKNOWN),
    ...options.capabilities?.(modelId),
  });
  return {
    capabilities: resolve,
    async *stream(request, call) {
      try {
        call.signal.throwIfAborted();
        const api = await model({ ...call, modelId: request.model, config: request.config });
        learned.set(request.model, capabilities(await api.supportedUrls));
        const params = buildRequest(request, call, await prepareMedia(request, call, resolve(request.model)));
        params.providerOptions = mapProviderOptions(params.providerOptions ?? {}, request, api.provider);
        addCacheBreakpoints(params, options.cache);
        const searchBudget = addProviderTools(request, params, api.provider);
        call.signal.throwIfAborted();
        const result = await api.doStream(params);
        const gatewayId = request.config.gateway ? result.response?.headers?.["cf-aig-log-id"] : undefined;
        for await (const event of mapStream(
          result.stream,
          api.modelId,
          api.provider,
          gatewayId,
          searchBudget ?? request.providerTools?.maxCalls ?? 0,
        ))
          yield await ingestProviderEvent(event, call);
      } catch (error) {
        yield {
          type: "error",
          error: call.signal.aborted
            ? { code: "aborted", message: error instanceof Error ? error.message : String(error), retryable: false }
            : toProviderError(error),
        };
      }
    },
  };
}

function capabilities(urls: Record<string, RegExp[]>): ModelCapabilities {
  const supports = (mime: string): true | "unknown" =>
    Object.keys(urls).some(
      (key) => urls[key]?.length && (key === "*/*" || key === mime || key === `${mime.split("/")[0]}/*`),
    )
      ? true
      : "unknown";
  return {
    image: supports("image/png"),
    audio: supports("audio/mpeg"),
    video: supports("video/mp4"),
    pdf: supports("application/pdf"),
  };
}
