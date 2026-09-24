import { defineAgent, KarmiError, type AgentSpec } from "@karmi/core";
import { describe, expect, it } from "vitest";
import { refreshAgents } from "../src/code-agents";

const parent = defineAgent({
  agentId: "parent",
  name: "Parent",
  instructions: [],
  model: { id: "new/model" },
  delegates: ["child"],
});
const child = defineAgent({ agentId: "child", name: "Child", instructions: [], model: { id: "new/model" } });
const CODE = new Map([parent, child].map((agent) => [agent.agentId, agent]));

/** A Scope that holds one stored copy for each given Agent id, and records each put. */
function scopeWith(stored: Record<string, { catalogueChanged: boolean }>) {
  const puts: AgentSpec[] = [];
  return {
    puts,
    agents: {
      get: async (agentId: string) => {
        const copy = stored[agentId];
        if (!copy) throw new KarmiError("agent.notFound", `Agent "${agentId}" does not exist in this Scope.`);
        return {
          agentId,
          version: 1,
          createdAt: 0,
          spec: { agentId, name: agentId, instructions: [], model: { id: "old/model" } },
          ...copy,
        };
      },
      put: async (spec: AgentSpec) => {
        puts.push(spec);
        return { agentId: spec.agentId, version: 2 };
      },
    },
  };
}

describe("refreshAgents", () => {
  it("stores the code definition again when the Catalogue changed after the Scope stored its copy", async () => {
    const scope = scopeWith({ parent: { catalogueChanged: true }, child: { catalogueChanged: true } });
    await refreshAgents(CODE, scope.agents, ["parent"]);
    // The Agent that the parent delegates to belongs to the same scenario.
    expect(scope.puts).toEqual([parent.spec, child.spec]);
  });

  it("keeps a copy that the current Catalogue validated", async () => {
    const scope = scopeWith({ parent: { catalogueChanged: false }, child: { catalogueChanged: false } });
    await refreshAgents(CODE, scope.agents, ["parent"]);
    expect(scope.puts).toEqual([]);
  });

  it("skips an Agent that the Scope never stored, because its first Turn stores the code definition", async () => {
    const scope = scopeWith({});
    await refreshAgents(CODE, scope.agents, ["parent", "stored-at-runtime"]);
    expect(scope.puts).toEqual([]);
  });
});
