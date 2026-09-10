import Anthropic from "@anthropic-ai/sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { retry, type Provider, type ProviderCallOptions, type ProviderConfig, type ProviderError, type ProviderEvent } from "@karmi/core";
import { toProviderError } from "./errors.js";
import { gatewaySettings } from "./gateway.js";
import { capabilities } from "./models.js";
import { anthropicOptions } from "./options.js";
import { buildParams, countTokensParams } from "./request.js";
import { mapStream } from "./stream.js";

/** Resolves a profile's credential reference (`scope:<name>` or `deployment:<name>`) to its value. */
export type CredentialResolver = (ref: string) => string | undefined | Promise<string | undefined>;

export interface AnthropicProviderOptions {
  /** The key for profiles that name no `credential`. */
  apiKey?: string;
  /** How `credential` references resolve, as a map or a function; the secret store's seam until it lands. */
  credentials?: Record<string, string> | CredentialResolver;
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
  const resolve = toResolver(options.credentials);

  async function client(config: ProviderConfig, call: ProviderCallOptions): Promise<Client> {
    const byok = config.gateway?.byok === true;
    const apiKey = byok ? undefined : config.credential ? await resolve(config.credential) : options.apiKey;
    if (!byok && !apiKey) throw new ProviderFailure({ code: "auth", message: config.credential ? `Credential "${config.credential}" did not resolve.` : "The Provider profile names no credential and the adapter has no apiKey.", retryable: false });
    const headers: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) if (name.toLowerCase() !== "anthropic-beta") headers[name] = value;
    let baseURL = config.baseUrl;
    if (config.gateway) {
      const token = config.gateway.credential ? await resolve(config.gateway.credential) : undefined;
      if (config.gateway.credential && !token) throw new ProviderFailure({ code: "auth", message: `Gateway credential "${config.gateway.credential}" did not resolve.`, retryable: false });
      const gateway = gatewaySettings(config.gateway, token, call.attribution);
      baseURL = gateway.baseURL;
      Object.assign(headers, gateway.headers);
    }
    // With the key held by the gateway, no provider auth header may leave the Worker at all.
    if (byok) Object.assign(headers, { "x-api-key": null, authorization: null });
    return new Client({ apiKey: apiKey ?? null, authToken: null, baseURL: baseURL ?? null, defaultHeaders: headers, fetch: call.fetch, maxRetries: 0, timeout: config.gateway?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  return {
    async *stream(request, call): AsyncIterable<ProviderEvent> {
      const { logger, signal } = call;
      let events: AsyncIterable<BetaRawMessageStreamEvent>;
      let gateway: { provider: "cloudflare"; id: string } | undefined;
      try {
        const api = await client(request.config, call);
        const params = buildParams(request);
        // Retrying is only safe before the first byte: karmi retries the connection, never a stream.
        const attempts = request.config.gateway?.retry ? 1 : 3;
        const { data, response } = await retry(() => api.beta.messages.create({ ...params, stream: true }, { signal }).withResponse(), { attempts, signal, retryable: (error) => toProviderError(error).retryable });
        events = data;
        const logId = response.headers.get("cf-aig-log-id");
        if (logId && request.config.gateway) gateway = { provider: "cloudflare", id: logId };
      } catch (error) {
        yield { type: "error", error: failure(error) };
        return;
      }
      try {
        yield* mapStream(events, { logger, raw: anthropicOptions(request).raw, gateway });
      } catch (error) {
        yield { type: "error", error: failure(error) };
      }
    },
    async countTokens(request, call) {
      try {
        const api = await client(request.config, call);
        const { input_tokens } = await api.beta.messages.countTokens(countTokensParams(request), { signal: call.signal });
        return { tokens: input_tokens };
      } catch (error) {
        return { error: failure(error) };
      }
    },
    capabilities,
  };
}

function failure(error: unknown): ProviderError {
  return error instanceof ProviderFailure ? error.error : toProviderError(error);
}

function toResolver(credentials: AnthropicProviderOptions["credentials"]): CredentialResolver {
  if (credentials === undefined) return () => undefined;
  if (typeof credentials === "function") return credentials;
  return (ref) => credentials[ref];
}
