import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assembleCatalogue, defineFragment, type AgentSpec, type FragmentContext } from "../src/index.js";
import { evaluatePrompt } from "../src/prompt.js";

const greeting = defineFragment({
  name: "greeting",
  args: z.object({ name: z.string(), tone: z.string().default("warm") }),
  render: (ctx, { name, tone }) => `Greet ${name} for ${ctx.user ?? "nobody"} in a ${tone} tone.`,
});
const silent = defineFragment({ name: "silent", render: () => null });
const catalogue = assembleCatalogue({ fragments: [greeting, silent] });
const ctx: FragmentContext = {
  model: "anthropic/claude-sonnet-5",
  scope: "test",
  user: "u1",
  thread: { id: "t1" },
  tools: [],
  now: new Date(0),
};
const spec = (instructions: AgentSpec["instructions"]): AgentSpec => ({
  agentId: "a",
  name: "A",
  instructions,
  model: { id: "anthropic/claude-sonnet-5" },
});

describe("evaluatePrompt", () => {
  it("joins text and Fragment entries in order, applying Fragment arg defaults and dropping empty renders", async () => {
    const prompt = await evaluatePrompt(
      spec([
        { text: "Be brief." },
        { fragment: "greeting", args: { name: "Ada" } },
        { fragment: "silent" },
        { text: "" },
        { text: "Sign off." },
      ]),
      catalogue,
      ctx,
    );
    expect(prompt).toBe("Be brief.\n\nGreet Ada for u1 in a warm tone.\n\nSign off.");
  });

  it("keeps only the entries whose models glob matches the model in use", async () => {
    const instructions: AgentSpec["instructions"] = [
      { text: "Everyone." },
      { text: "Claude only.", models: "anthropic/*" },
      { text: "GPT only.", models: ["openai/*"] },
    ];
    expect(await evaluatePrompt(spec(instructions), catalogue, ctx)).toBe("Everyone.\n\nClaude only.");
    expect(await evaluatePrompt(spec(instructions), catalogue, { ...ctx, model: "openai/gpt-5" })).toBe(
      "Everyone.\n\nGPT only.",
    );
  });

  it("is undefined when nothing renders", async () => {
    expect(await evaluatePrompt(spec([{ fragment: "silent" }]), catalogue, ctx)).toBeUndefined();
  });
});
