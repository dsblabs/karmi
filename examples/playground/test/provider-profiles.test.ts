import { SensitiveValue, type ProviderRequest } from "@karmi/core";
import { describe, expect, it } from "vitest";
import { deploymentProviders, type DeploymentProviders } from "../src/providers";

const VARS = { PLAYGROUND_PROVIDER: "openai", PLAYGROUND_MODEL: "gpt-5", PROVIDER_API_KEY: "sk-first" };
const GATEWAY = { PLAYGROUND_GATEWAY_ACCOUNT: "acct", PLAYGROUND_GATEWAY_ID: "gw", GATEWAY_TOKEN: "gw-token" };

/** Builds the profiles and fails the test when setup is not complete. */
function build(vars: Record<string, string>): DeploymentProviders {
  const built = deploymentProviders(vars);
  if (!built) throw new Error("Setup is not complete.");
  return built;
}

/**
 * Sends one call through the Provider of a profile with a fetch that records the request and answers with an error.
 * Returns the URL and the headers of the request.
 */
async function firstRequest(built: DeploymentProviders, profile: string) {
  const choice = built.choices.find((entry) => entry.name === profile);
  const provider = choice && built.providers[choice.config.adapter];
  if (!choice || !provider) throw new Error(`No profile ${profile}.`);
  const sent: Request[] = [];
  const request: ProviderRequest = {
    model: choice.model.slice(choice.model.indexOf("/") + 1),
    config: choice.config,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
  };
  const stream = provider.stream(request, {
    fetch: async (input, init) => {
      sent.push(new Request(input, init));
      return Response.json({ error: { message: "stop" } }, { status: 400 });
    },
    signal: new AbortController().signal,
    credentials: { provider: new SensitiveValue("sk-first"), gateway: new SensitiveValue("gw-token") },
    attribution: { scope: "sample-a", agent: "provider-desk", thread: "t1", turn: 1 },
  });
  for await (const event of stream) if (event.type === "error") break;
  const [first] = sent;
  if (!first) throw new Error("The Provider sent no request.");
  return { url: first.url, headers: Object.fromEntries(first.headers) };
}

describe("the Provider profiles of setup", () => {
  it("has only the default profile without a second Provider or a gateway", () => {
    const built = build(VARS);
    expect(built.choices.map(({ name, model }) => ({ name, model }))).toEqual([
      { name: "default", model: "openai/gpt-5" },
    ]);
    // OpenAI uses the adapter name on which karmi offers Provider Tools.
    expect(built.choices[0]?.config).toEqual({
      adapter: "ai-sdk",
      models: ["openai/*"],
      credential: "deployment:provider",
    });
    expect(Object.keys(built.providers)).toEqual(["ai-sdk"]);
  });

  it("adds the second Provider and the gateway, and each profile names its credentials only", () => {
    const built = build({
      ...VARS,
      ...GATEWAY,
      PLAYGROUND_SECOND_PROVIDER: "anthropic",
      PLAYGROUND_SECOND_MODEL: "claude-sonnet-5",
      SECOND_PROVIDER_API_KEY: "sk-second",
    });
    expect(built.choices.map(({ name, model }) => ({ name, model }))).toEqual([
      { name: "default", model: "openai/gpt-5" },
      { name: "second", model: "anthropic/claude-sonnet-5" },
      { name: "gateway", model: "openai/gpt-5" },
    ]);
    expect(built.choices[2]?.config.gateway).toEqual({
      kind: "cloudflare",
      accountId: "acct",
      gatewayId: "gw",
      credential: "deployment:gateway",
    });
    expect(Object.keys(built.providers).sort()).toEqual(["ai-sdk", "anthropic"]);
    expect(built.credentials).toEqual({ provider: "sk-first", "second-provider": "sk-second", gateway: "gw-token" });
    expect(JSON.stringify(built.choices)).not.toMatch(/sk-first|sk-second|gw-token/);
  });

  it("offers no gateway for a custom endpoint", () => {
    const built = build({
      ...GATEWAY,
      PLAYGROUND_PROVIDER: "custom",
      PLAYGROUND_MODEL: "llama",
      PLAYGROUND_BASE_URL: "https://llm.example/v1",
      PROVIDER_API_KEY: "sk-first",
    });
    expect(built.choices.map((choice) => choice.name)).toEqual(["default"]);
  });

  it("has no profiles before setup", () => {
    expect(deploymentProviders({})).toBeUndefined();
  });
});

describe("AI Gateway routing", () => {
  it("sends an AI SDK call to the Provider path of the gateway with the token and the attribution", async () => {
    const built = build({ ...VARS, ...GATEWAY });
    const direct = await firstRequest(built, "default");
    expect(new URL(direct.url).host).toBe("api.openai.com");

    const routed = await firstRequest(built, "gateway");
    expect(routed.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/responses");
    expect(routed.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
    expect(JSON.parse(routed.headers["cf-aig-metadata"] ?? "{}")).toEqual({
      scope: "sample-a",
      agent: "provider-desk",
      thread: "t1",
      turn: 1,
    });
  });

  it("sends an Anthropic call to the Anthropic path of the gateway", async () => {
    const built = build({
      ...GATEWAY,
      PLAYGROUND_PROVIDER: "anthropic",
      PLAYGROUND_MODEL: "claude-sonnet-5",
      PROVIDER_API_KEY: "sk-first",
    });
    const routed = await firstRequest(built, "gateway");
    expect(routed.url).toMatch(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/acct\/gw\/anthropic\/v1\/messages/);
    expect(routed.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });
});
