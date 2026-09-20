import { defineFragment, type AgentSpec, type ScopeConfigDocument } from "@karmi/core";
import { z } from "zod";

/** The id of the Agent Spec scenario. */
export const AGENTS = "agents";
/** The id of the Agent that the scenario stores at runtime. No code defines this Agent. */
export const ASSISTANT = "shop-assistant";

/** The prompts that the scenario suggests. The operator can edit each one. */
export const ASSISTANT_PROMPTS = [
  { label: "Ask about returns", text: "I bought a kettle 3 weeks ago. Can I still return it?" },
];

/** The arguments that a Prompt entry gives to the `shop_policy` Fragment. */
export const shopPolicyArgs = z.object({ returnDays: z.number().int().positive() });

/** Tells the model the return rule of the shop. The Harness renders it again at the start of each Turn. */
export const shopPolicy = defineFragment({
  name: "shop_policy",
  description: "The return rule of the sample shop",
  args: shopPolicyArgs,
  render: ({ user, now }, { returnDays }) =>
    `Shop rule: a customer can return an item for ${returnDays} days after the purchase. You speak with ${user ?? "a guest"}. Today is ${now.toISOString().slice(0, 10)}.`,
});

const role = (text: string) => ({ text: `${text} Answer in one or two sentences.` });
const policy = (returnDays: number) => ({ fragment: "shop_policy", args: { returnDays } });

/** The Spec that the scenario starts with and that a reset stores again. */
export const startingSpec = (model: string): AgentSpec => ({
  agentId: ASSISTANT,
  name: "Shop assistant",
  instructions: [role("You are the assistant of a small coffee equipment shop."), policy(30)],
  model: { id: model },
});

/**
 * The config of the sample Scope. The ceiling is the maximum that an Agent Spec of this Scope can grant. A Spec that
 * asks for more does not pass validation.
 */
export const SCOPE_CONFIG: ScopeConfigDocument = { ceilings: { scheduling: { maxPending: 2 } } };

/** A Spec change that the page offers as one button. */
export interface SpecPreset {
  label: string;
  /** What the operator sees after the change. */
  expect: string;
  spec: AgentSpec;
}

/** The Spec changes that the page offers. The operator can also edit the JSON. */
export const presets = (model: string): SpecPreset[] => {
  const start = startingSpec(model);
  return [
    {
      label: "Change the instructions",
      expect: "The next Turn answers as a pirate. No deploy is necessary.",
      spec: { ...start, instructions: [role("Answer each message as a pirate."), policy(30)] },
    },
    {
      label: "Change the Fragment arguments",
      expect: "The Prompt and the answer use a return time of 7 days.",
      spec: { ...start, instructions: [role("You are the assistant of a small coffee equipment shop."), policy(7)] },
    },
    {
      label: "Grant in the ceiling",
      expect: "The Scope stores the Spec. The Agent gets the Schedule Tools.",
      spec: { ...start, capabilities: { scheduling: { maxPending: 2 } } },
    },
    {
      label: "Grant more than the ceiling",
      expect: "The Scope rejects the Spec with capability.over-ceiling and keeps the stored version.",
      spec: { ...start, capabilities: { scheduling: { maxPending: 50 } } },
    },
  ];
};
