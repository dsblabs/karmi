import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Provider, ProviderCallOptions, ProviderConfig, ModelCapabilities } from "@karmi/core";
import { mapProviderOptions } from "./options.js";
import { buildRequest } from "./request.js";
import { mapStream } from "./stream.js";
import { toProviderError } from "./errors.js";

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
        const params = buildRequest(request, call);
        const api = await model({ ...call, modelId: request.model, config: request.config });
        known.set(request.model, capabilities(await api.supportedUrls));
        params.providerOptions = mapProviderOptions(params.providerOptions ?? {}, request, api.provider);
        call.signal.throwIfAborted();
        const result = await api.doStream(params);
        const gatewayId = request.config.gateway ? result.response?.headers?.["cf-aig-log-id"] : undefined;
        yield* mapStream(result.stream, api.modelId, api.provider, gatewayId);
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
