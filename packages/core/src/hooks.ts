import type { AgentSpec } from "./agent.js";
import type { Catalogue } from "./catalogue.js";
import type { Hook, HookPoint } from "./hook.js";

/** The Hooks an Agent attached at one point, in Spec order; the Spec was validated, so every name resolves. */
export function hooksAt<P extends HookPoint>(spec: AgentSpec, catalogue: Catalogue, point: P): Hook<P>[] {
  return (spec.hooks?.[point] ?? []).flatMap((name) => {
    const hook = catalogue.hooks.get(name);
    return hook && hook.point === point ? [hook as Hook<P>] : [];
  });
}
