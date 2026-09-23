import type { Scope, Thread, ThreadStatus, UsageRecord } from "@karmi/core";
import { AGENTS, ASSISTANT, presets, SCOPE_CONFIG, shopPolicy, shopPolicyArgs, startingSpec } from "./assistant";
import { decodeDispatch, decodeReport, DISPATCH, reportBooking, TURNS } from "./dispatch";
import { COMPACTION, CONTEXT, decodeHold, decodeLedger, isHeld, LEDGER, readLedgerOf, writeLedger } from "./ledger";
import { BUYER, decodePurchases, DELEGATION, MANAGER } from "./purchases";
import {
  awaitsDelivery,
  currentThread,
  decodeObservability,
  EXAMPLE_CHILD_RECORD,
  failNextDelivery,
  OBSERVABILITY,
  replayLastBatch,
  storeRedaction,
} from "./observability";
import { decodeOrder, REFUND } from "./refund";
import { routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";
import { scriptRuns } from "./script-runs";
import { decodeScriptOrders, SCRIPT_LIMITS, scriptsAgent, SCRIPTS } from "./scripts";
import { adjustStock, checkStock, decodeStock, deleteProduct, STOCKROOM, stockroomAgent } from "./stockroom";

/** The sample Scope that the scenarios run in. */
export const SCOPE = "sample-a";
/** The second sample Scope. Only the Memory scenario uses it, to show that nothing crosses a Scope. */
export const OTHER_SCOPE = "sample-b";
/** The sample Scopes that the access token opens, in the order that the page shows them. */
export const SAMPLE_SCOPES: readonly string[] = [SCOPE, OTHER_SCOPE];
/** The User of the one operator. */
export const USER = "operator";

/**
 * One action of a scenario, at `POST /api/scenarios/{id}/{action}`. `stub` is the sample system of the scenario
 * and `open` opens its Thread for one generation. It returns an error answer, or nothing when the route must
 * answer with the state of the scenario.
 */
export type ScenarioAction = (
  stub: DurableObjectStub<SampleDataDO>,
  open: (generation: number) => Thread,
  request: Request,
) => Promise<Response | undefined>;

/**
 * Reports the outcome of the courier Job of the Turn control scenario, which resumes the parked Turn. The
 * operator plays the part of the external courier system. Returns an error answer when the body is not a
 * report or when no Turn waits for the Job.
 */
const reportJob: ScenarioAction = async (stub, open, request) => {
  const report = decodeReport(await request.json().catch(() => undefined));
  if (!report)
    return routeError(400, "http.badRequest", 'The body must be {"report":"collected"} or {"report":"failed"}.');
  // One read gives the booking and the generation, thus no stale copy meets a fresh one.
  const stored = await stub.read();
  const dispatch = decodeDispatch(stored.data);
  const booking = dispatch.booking;
  const thread = open(stored.generation);
  if (!booking || (await thread.status()).paused !== "job")
    return routeError(409, "playground.noJob", "No Turn waits for the courier Job.");
  // The Thread comes first. The sample courier system then cannot report an outcome that no Turn received.
  if (report === "collected")
    await thread.jobs.complete(booking.jobId, {
      content: [{ type: "text", text: `The courier collected ${booking.parcels} parcels.` }],
    });
  else await thread.jobs.fail(booking.jobId, "The courier did not arrive. The collection failed.");
  await stub.write(JSON.stringify(reportBooking(dispatch, report)));
  return undefined;
};

/**
 * Holds or releases the sample ledger of the Compaction and recovery scenario. A held ledger makes each Tool
 * call wait, thus the operator can stop the dev server during the call. Returns an error answer when the body
 * has no boolean `held`.
 */
const holdLedger: ScenarioAction = async (stub, _open, request) => {
  const hold = decodeHold(await request.json().catch(() => undefined));
  if (!hold)
    return routeError(
      400,
      "http.badRequest",
      'The body must be {"held":true}, {"held":true,"from":8} or {"held":false}.',
    );
  const { holdFrom: _, ...ledger } = await readLedgerOf(stub);
  await writeLedger(stub, hold.held ? { ...ledger, holdFrom: hold.from ?? ledger.entries.length } : ledger);
  return undefined;
};

/** The Turn state that a page shows next to the conversation, without the event log. */
const turnView = (status: ThreadStatus) => ({ state: status.state, paused: status.paused });

/** The server side of one scenario: its Agent and what the page shows next to the conversation. */
export interface Runtime {
  /** The id of the Agent that the Thread of the scenario runs. */
  agent: string;
  /** The actions of the scenario, by the last path segment of their route. */
  actions?: Record<string, ScenarioAction>;
  /** Makes what must exist before the Thread of the scenario can exist. */
  prepare?(): Promise<void>;
  /** Runs after the reset of the Thread and the sample data. */
  restore?(): Promise<void>;
  /** Returns the child Threads that the Thread of the scenario delegated to. A reset deletes each one. */
  children?(thread: Thread): Promise<Thread[]>;
  /**
   * Returns what the page shows next to the conversation. `data` is the stored sample data of the scenario,
   * `status` is the state of its Thread and `thread` is the Thread.
   */
  view(
    data: string | undefined,
    status: ThreadStatus,
    thread: Thread,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** The Usage records in the log of a Thread. A child records its own spend, thus no record occurs two times. */
async function usageRecordsOf(thread: Thread): Promise<UsageRecord[]> {
  return (await thread.events()).filter((event): event is UsageRecord => event.type === "usage.recorded");
}

/**
 * The runtime of the Delegation scenario. The page shows each child Thread of the parent with its parent link, and
 * the Usage records of the parent and of each child.
 */
function delegationRuntime(scope: () => Scope): Runtime {
  const children = async (thread: Thread) =>
    (await scope().threads.list({ agent: BUYER, user: USER, parent: thread.key })).map((child) =>
      scope().thread(child.key),
    );
  return {
    agent: MANAGER,
    children,
    async view(stored, status, thread) {
      const threads = await children(thread);
      const statuses = await Promise.all(threads.map((child) => child.status()));
      const usage = (await Promise.all([thread, ...threads].map(usageRecordsOf))).flat();
      return {
        purchases: decodePurchases(stored),
        turn: { ...turnView(status), delegated: status.budget?.delegated },
        children: threads.map((child, index) => {
          const childStatus = statuses[index];
          return {
            threadKey: child.key,
            threadId: child.identity.threadId,
            agent: child.identity.agent,
            parent: childStatus?.parent,
            state: childStatus?.state,
            paused: childStatus?.paused,
          };
        }),
        usage,
      };
    },
  };
}

/**
 * The runtime of the isolate Scripts scenario. The page shows the sample orders, the grant and each Script of the
 * Thread with its nested Tool calls, which it reads from the event log.
 */
function scriptsRuntime(model: string): Runtime {
  const { capabilities, policy } = scriptsAgent(model).spec;
  return {
    agent: SCRIPTS,
    async view(stored, status, thread) {
      return {
        orders: decodeScriptOrders(stored),
        grant: { ...capabilities?.scripts, limits: SCRIPT_LIMITS },
        policy,
        runs: scriptRuns(thread.identity.threadId, await thread.events(), SCRIPT_LIMITS),
        turn: turnView(status),
      };
    },
  };
}

/** The runtime of the Usage and logging scenario. The page shows the Usage records, the UsageHandler and the logs. */
function observabilityRuntime(): Runtime {
  return {
    agent: OBSERVABILITY,
    actions: {
      fail: async (stub) => {
        await failNextDelivery(stub);
        return undefined;
      },
      replay: (stub, open) => replayLastBatch(stub, open),
      redact: async (stub) => {
        await storeRedaction(stub);
        return undefined;
      },
    },
    async view(stored, _status, thread) {
      const data = currentThread(decodeObservability(stored), thread.identity.threadId);
      const usage = await usageRecordsOf(thread);
      return {
        usage,
        handler: {
          failNext: data.failNext,
          deliveries: data.deliveries,
          waiting: awaitsDelivery(usage, data.deliveries),
        },
        logs: data.logs,
        ...(data.redaction && { redaction: data.redaction }),
        exampleChild: EXAMPLE_CHILD_RECORD,
      };
    },
  };
}

/** The runtime of the Agent Spec scenario. Its Agent is stored data, thus the runtime stores the starting Spec. */
function assistantRuntime(scope: () => Scope, model: string): Runtime {
  const storeStartingSpec = async () => {
    await scope().config.set(SCOPE_CONFIG);
    await scope().agents.put(startingSpec(model));
  };
  return {
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
  };
}

/**
 * Returns the server side of each built scenario that uses the shared state and reset routes, by scenario id.
 * `scope` opens the sample Scope. The routes call it for each request, because the Workers runtime allows random
 * values only while it handles a request.
 */
export function scenarioRuntimes(scope: () => Scope, model: string): Record<string, Runtime> {
  return {
    [REFUND]: { agent: REFUND, view: (stored) => ({ order: decodeOrder(stored) }) },
    [TURNS]: {
      agent: DISPATCH,
      actions: { job: reportJob },
      view: (stored, status) => ({
        dispatch: decodeDispatch(stored),
        // The page shows the Turn state, thus pending work and its budget are visible without the event log.
        turn: { ...turnView(status), budget: status.budget },
      }),
    },
    [COMPACTION]: {
      agent: LEDGER,
      actions: { hold: holdLedger },
      view: (stored, status) => {
        const ledger = decodeLedger(stored);
        return { ledger: { ...ledger, held: isHeld(ledger) }, context: CONTEXT, turn: turnView(status) };
      },
    },
    [STOCKROOM]: {
      agent: STOCKROOM,
      view: (stored) => ({
        stock: decodeStock(stored),
        tools: [checkStock, adjustStock, deleteProduct].map(({ name, annotations }) => ({ name, annotations })),
        policy: stockroomAgent(model).spec.policy,
      }),
    },
    [AGENTS]: assistantRuntime(scope, model),
    [DELEGATION]: delegationRuntime(scope),
    [SCRIPTS]: scriptsRuntime(model),
    [OBSERVABILITY]: observabilityRuntime(),
  };
}
