import { profilesOf, type ProfileChoice } from "../src/providers";
/**
 * The Provider profiles of the test Workers. The scripted Provider serves each one. The adapter names `anthropic` and
 * `ai-sdk` are the ones on which karmi offers Provider Tools, thus the second and the gateway profile accept
 * `web_search` and the default one does not.
 */
export const PROFILES: readonly ProfileChoice[] = [
  { name: "default", label: "Scripted", model: "fake/model", config: { adapter: "fake", models: ["*"] } },
  {
    name: "second",
    label: "Anthropic (scripted)",
    model: "anthropic/claude-test",
    config: { adapter: "anthropic", models: ["anthropic/*"] },
  },
  {
    name: "gateway",
    label: "OpenAI through AI Gateway (scripted)",
    model: "openai/gpt-test",
    config: {
      adapter: "ai-sdk",
      models: ["openai/*"],
      gateway: { kind: "cloudflare", accountId: "test-account", gatewayId: "playground" },
    },
  },
];

/** The `defaults.providers` of the test Workers. */
export const PROFILE_CONFIGS = profilesOf(PROFILES);
