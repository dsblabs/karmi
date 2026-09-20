import type { Scope } from "@karmi/core";
import { AGENTS, ASSISTANT, presets, SCOPE_CONFIG, shopPolicy, shopPolicyArgs, startingSpec } from "./assistant";
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
  /** Returns what the page shows next to the conversation. `data` is the stored sample data of the scenario. */
  view(data: string | undefined): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Returns the server side of each built scenario by scenario id. `scope` opens the sample Scope. The routes call it
 * for each request, because the Workers runtime allows random values only while it handles a request.
 */
export function scenarioRuntimes(scope: () => Scope, model: string): Record<string, Runtime> {
  const storeStartingSpec = async () => {
    await scope().config.set(SCOPE_CONFIG);
    await scope().agents.put(startingSpec(model));
  };

  return {
    [REFUND]: { agent: REFUND, view: (stored) => ({ order: decodeOrder(stored) }) },
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
