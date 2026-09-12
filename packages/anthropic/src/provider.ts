import Anthropic from "@anthropic-ai/sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  retry,
  prepareMedia,
  ingestProviderEvent,
  type Provider,
  type ProviderCallOptions,
  type ProviderConfig,
  type ProviderError,
  type ProviderEvent,
} from "@karmi/core";
import { toProviderError } from "./errors";
import { gatewaySettings } from "./gateway";
import { capabilities } from "./models";
import { anthropicOptions } from "./options";
import { buildParams, countTokensParams } from "./request";
import { mapStream } from "./stream";

export interface AnthropicProviderOptions {
  /** The key for profiles that name no `credential`; a profile's own reference is resolved by karmi and handed to each call. */
  apiKey?: string;
}

/** The SDK's default credential chain reads local config and environment; karmi always says where a key comes from. */
class Client extends Anthropic {
  protected override _shouldResolveDefaultCredentials(): boolean {
    return false;
  }
}

class ProviderFailure extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message);
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The Anthropic Provider: `createKarmi({ providers: { anthropic: anthropic({ apiKey }) } })`. */
export function anthropic(options: AnthropicProviderOptions = {}): Provider {
  const client = (config: ProviderConfig, call: ProviderCallOptions) => createClient(config, call, options.apiKey);

  return {
    async *stream(request, call): AsyncIterable<ProviderEvent> {
      const { logger, signal } = call;
      let events: AsyncIterable<BetaRawMessageStreamEvent>;
      let gateway: { provider: "cloudflare"; id: string } | undefined;
      try {
        const api = client(request.config, call);
        const params = buildParams(request, await prepareMedia(request, call, capabilities(request.model)));
        // Retrying is only safe before the first byte: karmi retries the connection, never a stream.
        const attempts = request.config.gateway?.retry ? 1 : 3;
        const { data, response } = await retry(
          () => api.beta.messages.create({ ...params, stream: true }, { signal }).withResponse(),
          { attempts, signal, retryable: (error) => toProviderError(error).retryable },
        );
        events = data;
        const logId = response.headers.get("cf-aig-log-id");
        if (logId && request.config.gateway) gateway = { provider: "cloudflare", id: logId };
      } catch (error) {
        yield { type: "error", error: failure(error) };
        return;
      }
      try {
        for await (const event of mapStream(events, { logger, raw: anthropicOptions(request).raw, gateway }))
          yield await ingestProviderEvent(event, call);
      } catch (error) {
        yield { type: "error", error: failure(error) };
      }
    },
    async countTokens(request, call) {
      try {
        const api = client(request.config, call);
        const { input_tokens } = await api.beta.messages.countTokens(
          countTokensParams(request, await prepareMedia(request, call, capabilities(request.model))),
          {
            signal: call.signal,
          },
        );
        return { tokens: input_tokens };
      } catch (error) {
        return { error: failure(error) };
      }
    },
    capabilities,
  };
}

// The credentials are exposed here and nowhere else: they go into the client for this one call.
function createClient(config: ProviderConfig, call: ProviderCallOptions, defaultKey: string | undefined): Client {
  const byok = config.gateway?.byok === true;
  const apiKey = byok ? undefined : config.credential ? call.credentials?.provider?.expose() : defaultKey;
  if (!byok && !apiKey)
    throw new ProviderFailure({
      code: "auth",
      message: config.credential
        ? `Credential "${config.credential}" was not resolved for this call.`
        : "The Provider profile names no credential and the adapter has no apiKey.",
      retryable: false,
    });
  const headers: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(config.headers ?? {}))
    if (name.toLowerCase() !== "anthropic-beta") headers[name] = value;
  let baseURL = config.baseUrl;
  if (config.gateway) {
    const token = config.gateway.credential ? call.credentials?.gateway?.expose() : undefined;
    if (config.gateway.credential && !token)
      throw new ProviderFailure({
        code: "auth",
        message: `Gateway credential "${config.gateway.credential}" was not resolved for this call.`,
        retryable: false,
      });
    const gateway = gatewaySettings(config.gateway, token, call.attribution);
    baseURL = gateway.baseURL;
    Object.assign(headers, gateway.headers);
  }
  // With the key held by the gateway, no provider auth header may leave the Worker at all.
  if (byok) Object.assign(headers, { "x-api-key": null, authorization: null });
  return new Client({
    apiKey: apiKey ?? null,
    authToken: null,
    baseURL: baseURL ?? null,
    defaultHeaders: headers,
    fetch: call.fetch,
    maxRetries: 0,
    timeout: config.gateway?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

function failure(error: unknown): ProviderError {
  return error instanceof ProviderFailure ? error.error : toProviderError(error);
}
