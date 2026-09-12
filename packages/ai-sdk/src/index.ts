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
import { buildRequest } from "./request";
import { mapStream } from "./stream";
import { toProviderError } from "./errors";

export interface ModelFactoryContext extends ProviderCallOptions {
  modelId: string;
  config: ProviderConfig;
}
export type ModelFactory = (context: ModelFactoryContext) => LanguageModelV4 | PromiseLike<LanguageModelV4>;

/** Construct provider clients inside the factory so each call uses its Scope's fetch and credentials. */
export function aiSdk(model: ModelFactory): Provider {
  const known = new Map<string, ModelCapabilities>();
  return {
    capabilities: (modelId) =>
      known.get(modelId) ?? { image: "unknown", audio: "unknown", video: "unknown", pdf: "unknown" },
    async *stream(request, call) {
      try {
        call.signal.throwIfAborted();
        const api = await model({ ...call, modelId: request.model, config: request.config });
        const supported = capabilities(await api.supportedUrls);
        known.set(request.model, supported);
        const params = buildRequest(request, call, await prepareMedia(request, call, supported));
        params.providerOptions = mapProviderOptions(params.providerOptions ?? {}, request, api.provider);
        call.signal.throwIfAborted();
        const result = await api.doStream(params);
        const gatewayId = request.config.gateway ? result.response?.headers?.["cf-aig-log-id"] : undefined;
        for await (const event of mapStream(result.stream, api.modelId, api.provider, gatewayId))
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
