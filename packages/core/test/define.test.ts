import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineFragment, defineHook, defineRetriever, defineSkill, defineTool, KarmiError } from "../src/index.js";

const echo = defineTool({
  name: "echo",
  description: "Echoes its input",
  input: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

describe("define*", () => {
  it("returns frozen objects with their kind", () => {
    expect(Object.isFrozen(echo)).toBe(true);
    expect(echo.kind).toBe("tool");
    expect(Object.isFrozen(defineFragment({ name: "f", render: () => "x" }))).toBe(true);
    expect(Object.isFrozen(defineHook({ name: "h", point: "before-turn", run: () => {} }))).toBe(true);
    expect(Object.isFrozen(defineSkill({ name: "s", description: "d", body: () => "b" }))).toBe(true);
  });

  it("applies the MCP absent-defaults to tool annotations", () => {
    expect(echo.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    const t = defineTool({ name: "t", description: "d", input: z.object({}), annotations: { readOnlyHint: true }, execute: () => "" });
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });

  it.each(["", "Echo", "a b", "x".repeat(65), "with.dot"])("rejects the name %j", (name) => {
    expect(() => defineFragment({ name, render: () => null })).toThrow(KarmiError);
  });

  it("reserves __-prefixed, mcp: and built-in names", () => {
    for (const name of ["__private", "mcp:server", "run_script", "tool_search", "delegate"]) {
      expect(() => defineTool({ name, description: "d", input: z.object({}), execute: () => "" })).toThrowError(/reserved/);
    }
    // Built-in names are Tool names; other kinds may use them.
    expect(defineFragment({ name: "delegate", render: () => "" }).name).toBe("delegate");
  });

  it("validates agentId separately from Catalogue names", () => {
    expect(defineAgent({ agentId: "Concierge_1", name: "Concierge", instructions: [{ text: "hi" }], model: { id: "anthropic/claude-sonnet-5" } }).agentId).toBe("Concierge_1");
    expect(() => defineAgent({ agentId: "bad id", name: "x", instructions: [], model: { id: "m" } })).toThrow(KarmiError);
  });

  it("deep-freezes an Agent Spec", () => {
    const agent = defineAgent({ agentId: "a", name: "A", instructions: [{ text: "hi" }], model: { id: "m" }, tools: ["echo"] });
    expect(Object.isFrozen(agent.spec.instructions)).toBe(true);
    expect(Object.isFrozen(agent.spec.model)).toBe(true);
  });

  it("keeps a Skill's Tools reachable from the Skill", () => {
    const skill = defineSkill({ name: "research", description: "d", body: defineFragment({ name: "research_body", render: () => "…" }), tools: [echo] });
    expect(skill.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("accepts a settings schema on a Retriever", () => {
    const r = defineRetriever({ name: "fts", settings: z.object({ limit: z.number() }), search: async () => [] });
    expect(r.settings).toBeDefined();
  });
});
