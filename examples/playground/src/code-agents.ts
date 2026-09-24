import { KarmiError, type Agent, type Scope } from "@karmi/core";

/** The part of a Scope that `refreshAgents` reads and writes. */
type AgentStore = Pick<Scope["agents"], "get" | "put">;

/**
 * Stores the code definition of each named Catalogue Agent in a Scope again, with each Agent that it delegates to,
 * when the Catalogue changed after the Scope stored its copy.
 *
 * A Scope stores a copy of a code-defined Agent at its first Turn, and it keeps that copy after a change of the code.
 * Thus a model that `pnpm setup` changed, or an Agent that the code changed, reaches a scenario at its next reset.
 * An id that is not in the Catalogue, or that the Scope never stored, is skipped.
 */
export async function refreshAgents(
  catalogue: ReadonlyMap<string, Agent>,
  store: AgentStore,
  agentIds: readonly string[],
): Promise<void> {
  const seen = new Set<string>();
  const queue = [...agentIds];
  for (let agentId = queue.shift(); agentId !== undefined; agentId = queue.shift()) {
    const defined = catalogue.get(agentId);
    if (seen.has(agentId) || !defined) continue;
    seen.add(agentId);
    queue.push(...(defined.spec.delegates ?? []));
    const stored = await store.get(agentId).catch((caught: unknown) => {
      if (caught instanceof KarmiError && caught.code === "agent.notFound") return undefined;
      throw caught;
    });
    if (stored?.catalogueChanged) await store.put(defined.spec);
  }
}
