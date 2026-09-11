import { GATEWAY_HOST, type CallAttribution, type GatewayConfig } from "@karmi/core";

// Cloudflare AI Gateway is configuration, not code: a base URL and `cf-aig-*` headers on the same client.
// Attribution goes as `cf-aig-metadata`: karmi's four keys plus the first Platform entry, inside the gateway's
// five; karmi's keys win a name clash.

export interface GatewaySettings {
  baseURL: string;
  headers: Record<string, string>;
}

export function gatewaySettings(
  gateway: GatewayConfig,
  token: string | undefined,
  attribution: CallAttribution | undefined,
): GatewaySettings {
  const headers: Record<string, string> = {};
  if (token) headers["cf-aig-authorization"] = `Bearer ${token}`;
  const slot = Object.entries(gateway.metadata ?? {}).slice(0, 1);
  const metadata = { ...Object.fromEntries(slot), ...attribution };
  if (Object.keys(metadata).length > 0) headers["cf-aig-metadata"] = JSON.stringify(metadata);
  if (gateway.cache?.skip) headers["cf-aig-skip-cache"] = "true";
  if (gateway.cache?.ttl !== undefined) headers["cf-aig-cache-ttl"] = String(gateway.cache.ttl);
  if (gateway.cache?.key !== undefined) headers["cf-aig-cache-key"] = gateway.cache.key;
  if (gateway.retry?.maxAttempts !== undefined) headers["cf-aig-max-attempts"] = String(gateway.retry.maxAttempts);
  if (gateway.retry?.delayMs !== undefined) headers["cf-aig-retry-delay"] = String(gateway.retry.delayMs);
  if (gateway.retry?.backoff !== undefined) headers["cf-aig-backoff"] = gateway.retry.backoff;
  if (gateway.timeoutMs !== undefined) headers["cf-aig-request-timeout"] = String(gateway.timeoutMs);
  return { baseURL: `https://${GATEWAY_HOST}/v1/${gateway.accountId}/${gateway.gatewayId}/anthropic`, headers };
}
