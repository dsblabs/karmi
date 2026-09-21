import type { Scope, ThreadStatus } from "@karmi/core";
import { AGENTS, ASSISTANT, presets, SCOPE_CONFIG, shopPolicy, shopPolicyArgs, startingSpec } from "./assistant";
import { decodeDispatch, DISPATCH, TURNS } from "./dispatch";
import { decodeOrder, REFUND } from "./refund";
import { adjustStock, checkStock, decodeStock, deleteProduct, STOCKROOM, stockroomAgent } from "./stockroom";

/** The sample Scope that the scenarios run in. */
export const SCOPE = "sample-a";
/** The User of the one operator. */
export const USER = "operator";

/** The server side of one scenario: its Agent and what the page shows next to the conversation. */
export interface Runtime {
  /** The id of the Agent that the Thread of the scenario runs. */
  agent: string;
  /** Makes what must exist before the Thread of the scenario can exist. */
  prepare?(): Promise<void>;
  /** Runs after the reset of the Thread and the sample data. */
  restore?(): Promise<void>;
  /**
   * Returns what the page shows next to the conversation. `data` is the stored sample data of the scenario and
   * `status` is the state of its Thread.
   */
  view(data: string | undefined, status: ThreadStatus): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Returns the server side of each built scenario that uses the shared state and reset routes, by scenario id. `scope` opens the sample Scope. The routes call it
 * for each request, because the Workers runtime allows random values only while it handles a request.
 */
export function scenarioRuntimes(scope: () => Scope, model: string): Record<string, Runtime> {
  const storeStartingSpec = async () => {
    await scope().config.set(SCOPE_CONFIG);
    await scope().agents.put(startingSpec(model));
  };

  return {
    [REFUND]: { agent: REFUND, view: (stored) => ({ order: decodeOrder(stored) }) },
    [TURNS]: {
      agent: DISPATCH,
      view: (stored, status) => ({
        dispatch: decodeDispatch(stored),
        // The page shows the Turn state, thus pending work and its budget are visible without the event log.
        turn: { state: status.state, paused: status.paused, budget: status.budget },
      }),
    },
    [STOCKROOM]: {
      agent: STOCKROOM,
      view: (stored) => ({
        stock: decodeStock(stored),
        tools: [checkStock, adjustStock, deleteProduct].map(({ name, annotations }) => ({ name, annotations })),
        policy: stockroomAgent(model).spec.policy,
      }),
    },
    [AGENTS]: {
      agent: ASSISTANT,
      async prepare() {
        const stored = await scope().agents.list();
        if (!stored.some((agent) => agent.agentId === ASSISTANT)) await storeStartingSpec();
      },
      restore: storeStartingSpec,
      async view() {
        const { version, spec } = await scope().agents.get(ASSISTANT);
        const now = new Date();
        // The page shows what each Prompt entry gives. The Fragment is the same function that the Harness calls.
        const prompt = await Promise.all(
          spec.instructions.map(async (entry) =>
            "fragment" in entry
              ? {
                  source: `Fragment ${entry.fragment}`,
                  text:
                    entry.fragment === shopPolicy.name
                      ? await shopPolicy.render(
                          { model: spec.model.id, scope: SCOPE, user: USER, thread: { id: "preview" }, tools: [], now },
                          shopPolicyArgs.parse(entry.args),
                        )
                      : null,
                }
              : { source: "Text", text: entry.text },
          ),
        );
        return { agent: { version, spec }, prompt, presets: presets(model), ceilings: SCOPE_CONFIG.ceilings };
      },
    },
  };
}
