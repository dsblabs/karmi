import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assembleCatalogue, defineAgent, defineFragment, defineHook, defineRetriever, defineSkill, defineTool, KarmiError } from "../src/index.js";

const weather = defineTool({
  name: "weather",
  description: "Current weather for a city",
  input: z.object({ city: z.string().describe("City name") }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  settings: z.object({ units: z.enum(["c", "f"]).default("c") }),
  requires: "weather_api",
  execute: async ({ city }) => `Sunny in ${city}`,
});

const greeting = defineFragment({ name: "greeting", description: "Opens the prompt", args: z.object({ tone: z.string() }), render: (_ctx, { tone }) => `Be ${tone}.` });
const research = defineSkill({ name: "research", description: "Deep research", body: () => "Steps…", tools: [defineTool({ name: "search", description: "Search", input: z.object({ q: z.string() }), execute: () => "" })] });
const fts = defineRetriever({ name: "fts", description: "Full text", search: async () => [] });
const audit = defineHook({ name: "audit", point: "after-tool", description: "Logs tool calls", run: () => {} });
const concierge = defineAgent({ agentId: "concierge", name: "Concierge", description: "Front desk", instructions: [{ text: "Help." }], model: { id: "anthropic/claude-sonnet-5" }, tools: ["weather"] });

describe("assembleCatalogue", () => {
  it("rejects duplicate names within a kind", () => {
    expect(() => assembleCatalogue({ tools: [weather, weather] })).toThrowError(new KarmiError("name.duplicate", 'Duplicate tool name "weather" in the Catalogue.'));
    expect(() => assembleCatalogue({ agents: [concierge, concierge] })).toThrowError(/Duplicate agent "concierge"/);
  });

  it("treats a Skill's Tools as Tools for uniqueness", () => {
    const clash = defineTool({ name: "search", description: "x", input: z.object({}), execute: () => "" });
    expect(() => assembleCatalogue({ tools: [clash], skills: [research] })).toThrowError(/Duplicate tool name "search"/);
  });

  it("allows the same name across kinds", () => {
    const catalogue = assembleCatalogue({ tools: [weather], fragments: [defineFragment({ name: "weather", render: () => "" })] });
    expect(catalogue.tools.get("weather")).toBe(weather);
    expect(catalogue.fragments.get("weather")?.kind).toBe("fragment");
  });

  it("describes every item as JSON with schemas", () => {
    const description = assembleCatalogue({ tools: [weather], fragments: [greeting], skills: [research], retrievers: [fts], hooks: [audit], agents: [concierge] }).describe();
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    expect(description).toEqual({
      tools: [
        {
          name: "weather",
          description: "Current weather for a city",
          annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false, openWorldHint: true },
          input: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
          settings: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { units: { type: "string", enum: ["c", "f"], default: "c" } },
          },
          requires: "weather_api",
        },
      ],
      fragments: [
        {
          name: "greeting",
          description: "Opens the prompt",
          args: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { tone: { type: "string" } },
            required: ["tone"],
          },
        },
      ],
      skills: [{ name: "research", description: "Deep research", tools: ["search"] }],
      retrievers: [{ name: "fts", description: "Full text" }],
      hooks: [{ name: "audit", point: "after-tool", description: "Logs tool calls" }],
      agents: [{ agentId: "concierge", name: "Concierge", description: "Front desk" }],
    });
  });
});
