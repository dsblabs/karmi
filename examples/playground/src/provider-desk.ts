import { defineTool, type AgentSpec, type PolicyRule, type Scope } from "@karmi/core";
import { z } from "zod";
import { DEFAULT_PROFILE, type ProfileChoice } from "./providers";

/** The id of the Provider scenario. */
export const PROVIDERS = "providers";
/** The id of the Agent that the scenario stores at runtime. A switch stores a new version of it. */
export const PROVIDER_DESK = "provider-desk";
/** The one Provider Tool of the scenario. Anthropic and OpenAI support it. */
export const WEB_SEARCH = "web_search";
/** The call limits of the Provider Tool grant. */
export const WEB_SEARCH_LIMITS = { maxCallsPerTurn: 2, maxCallsPerThread: 6 };

/** The prompts that the scenario suggests. The operator can edit each one. */
export const PROVIDER_PROMPTS = [
  { label: "Which model", text: "In one sentence, which company made the model that answers this message?" },
  {
    label: "Harness Tool",
    text: "Use the shop_hours Tool and tell me when the sample shop opens on Saturday.",
  },
  {
    label: "Provider Tool",
    text: "Search the web for the current version of the Cloudflare Wrangler CLI and name your source.",
  },
];

/** The opening hours of the sample shop. */
const HOURS = { weekdays: "08:00-18:00", saturday: "09:00-14:00", sunday: "closed" };

/** A Harness Tool: the Worker runs it, after the Permission Policy allows the call. */
export const shopHours = defineTool({
  name: "shop_hours",
  description: "Read the opening hours of the sample shop",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  execute: () => JSON.stringify(HOURS),
});

const settingsSchema = z.object({
  /** The name of the Deployment profile that the Agent runs on. */
  profile: z.string(),
  /** True when the Agent has the Provider Tool grant. */
  webSearch: z.boolean(),
  /**
   * What the Permission Policy says about the Provider Tool. `none` has no rule, thus the grant allows the Tool. `ask`
   * is not valid for a Provider Tool, thus the Scope rejects a Spec with it.
   */
  policy: z.enum(["none", "allow", "deny", "ask"]),
});

/** The settings of the Agent that the page can change. */
export type DeskSettings = z.infer<typeof settingsSchema>;

/** Decodes the body of the settings route. Returns undefined for a body that is not valid. */
export function decodeSettings(body: unknown): DeskSettings | undefined {
  const parsed = settingsSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The settings of the Spec that the scenario starts with and that a reset stores again. */
export const STARTING_SETTINGS: Omit<DeskSettings, "profile"> = { webSearch: false, policy: "none" };

/** Builds the Agent Spec for a profile and the settings of the page. */
export function providerDeskSpec(choice: ProfileChoice, settings: DeskSettings): AgentSpec {
  const rules: PolicyRule[] = [
    { match: { tool: shopHours.name }, effect: "allow" },
    ...(settings.policy === "none" ? [] : [{ match: { tool: WEB_SEARCH }, effect: settings.policy }]),
  ];
  return {
    agentId: PROVIDER_DESK,
    name: "Provider desk",
    instructions: [
      {
        text: "You are the Provider desk of the karmi Playground. Answer in one or two sentences. Use shop_hours for the opening hours of the sample shop. Search the web only when the message asks for it.",
      },
    ],
    model: { id: choice.model, providerProfile: choice.name },
    tools: [shopHours.name],
    policy: rules,
    ...(settings.webSearch && {
      capabilities: { providerTools: { tools: [WEB_SEARCH], limits: WEB_SEARCH_LIMITS } },
    }),
  };
}

/** An Agent Spec as the Scope returns it. */
type StoredSpec = Awaited<ReturnType<Scope["agents"]["get"]>>["spec"];

/** Reads the settings back from a stored Spec. It is the inverse of `providerDeskSpec`. */
export function settingsOf(spec: StoredSpec): DeskSettings {
  const rule = spec.policy?.find((entry) => entry.match.tool === WEB_SEARCH);
  return {
    profile: spec.model.providerProfile ?? DEFAULT_PROFILE,
    webSearch: spec.capabilities?.providerTools?.tools.includes(WEB_SEARCH) ?? false,
    policy: rule?.effect ?? "none",
  };
}
