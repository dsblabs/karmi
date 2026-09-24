import { KarmiError, type Scope, type Thread } from "@karmi/core";
import { SCOPE_CONFIG } from "./assistant";
import {
  decodeInbox,
  decodeReminders,
  decodeScheduleId,
  decodeTiming,
  inboxChannel,
  INBOX_DATA,
  MAX_PENDING,
  reminderDue,
  REMINDERS,
  SCHEDULES,
  supplierDelivery,
  TIMING_MODES,
  type TimingRequest,
} from "./reminders";
import { routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface ScheduleRouteOptions {
  scope: () => Scope;
  scopeId: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
}

/** Opens the Thread of the Schedules scenario for one generation of its sample data. */
export const remindersThread = (scope: Scope, user: string, generation: number): Thread =>
  scope.thread({ agent: REMINDERS, user, threadId: `${REMINDERS}-${String(generation)}` });

/**
 * Sends the supplier Event of the external trigger to the Thread of the scenario. `source` names the system that
 * sent it. A Worker `scheduled` handler and the trigger route call it, thus the two do the same.
 */
export async function triggerSupplierDelivery(
  options: ScheduleRouteOptions,
  source: string,
  at: number,
): Promise<void> {
  const { generation } = await sampleData(options.data, options.scopeId, SCHEDULES).read();
  await remindersThread(options.scope(), options.user, generation).send(supplierDelivery(options.scopeId, source, at));
}

const timing = ({ mode, value }: TimingRequest) =>
  mode === "delay" ? { delay: value } : mode === "at" ? { at: value } : { cron: value };

interface ScheduleContext extends ScheduleRouteOptions {
  system(): DurableObjectStub<SampleDataDO>;
  inbox(): DurableObjectStub<SampleDataDO>;
  open(generation: number): Thread;
}

/**
 * Raises a stored Scope ceiling that is below the grant of the Agent. A Turn of an Agent with a grant above the
 * ceiling fails with `spec.invalid`. The routes that change the scenario call it, never the state route.
 */
async function raiseCeiling(scope: Scope): Promise<void> {
  const { document } = await scope.config.get();
  const stored = document.ceilings?.scheduling;
  const low = stored === false || (stored?.maxPending !== undefined && stored.maxPending < MAX_PENDING);
  if (low) await scope.config.set(SCOPE_CONFIG);
}

async function scenarioState(context: ScheduleContext): Promise<Response> {
  const stored = await context.system().read();
  const thread = context.open(stored.generation);
  // The status call through the identity creates the Thread. The other reads need no sequence.
  const status = await thread.status();
  const [schedules, delivered] = await Promise.all([thread.schedules(), context.inbox().read()]);
  const waiting = new Set(status.pendingApprovals?.map((approval) => approval.seq));
  return Response.json({
    threadKey: thread.key,
    schedules,
    reminders: decodeReminders(stored.data),
    // A delivery of a Thread before the last reset can arrive late. The inbox shows only the current Thread.
    inbox: decodeInbox(delivered.data)
      .filter((entry) => entry.threadKey === thread.key)
      .map((entry) => ({ ...entry, waiting: entry.kind === "approval" && waiting.has(entry.seq) })),
    modes: TIMING_MODES,
    channelRef: inboxChannel(context.scopeId),
  });
}

// The Framework validates the timing. The page shows its message, for example for a cron text with four fields.
async function change(context: ScheduleContext, work: (thread: Thread) => Promise<unknown>): Promise<Response> {
  const { generation } = await context.system().read();
  await raiseCeiling(context.scope());
  try {
    await work(context.open(generation));
  } catch (caught) {
    if (!(caught instanceof KarmiError)) throw caught;
    const { code, message } = caught;
    if (code === "schedule.notFound") return routeError(404, code, message);
    if (code === "schedule.invalid" || code === "schedule.limit") return routeError(400, code, message);
    throw caught;
  }
  return scenarioState(context);
}

async function resetScenario(context: ScheduleContext): Promise<Response> {
  const { generation } = await context.system().read();
  const thread = context.open(generation);
  // The cancel of each Schedule comes first, thus no recurring Schedule fires during the reset.
  for (const { scheduleId } of await thread.schedules()) await thread.cancelSchedule(scheduleId);
  await thread.cancel();
  await thread.delete();
  await Promise.all([context.system().reset(), context.inbox().reset(), raiseCeiling(context.scope())]);
  return scenarioState(context);
}

async function handle(context: ScheduleContext, request: Request, path: string): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined;
  if (path === "/api/scenarios/schedules/schedule") {
    const body = decodeTiming(await request.json().catch(() => undefined));
    if (!body)
      return routeError(400, "http.badRequest", "The body must name a mode of delay, at or cron, and a value.");
    return change(context, (thread) =>
      thread.schedule({ ...timing(body), input: reminderDue(context.scopeId, body.mode) }),
    );
  }
  if (path === "/api/scenarios/schedules/schedule/cancel") {
    const scheduleId = decodeScheduleId(await request.json().catch(() => undefined));
    if (!scheduleId) return routeError(400, "http.badRequest", "The body must name a Schedule in scheduleId.");
    return change(context, (thread) => thread.cancelSchedule(scheduleId));
  }
  if (path === "/api/scenarios/schedules/trigger") {
    await raiseCeiling(context.scope());
    await triggerSupplierDelivery(context, "The trigger route of the Playground", Date.now());
    return scenarioState(context);
  }
  return undefined;
}

/** Creates the authenticated application routes of the Schedules and offline delivery scenario. */
export function scheduleScenarioRoutes(options: ScheduleRouteOptions) {
  const context: ScheduleContext = {
    ...options,
    system: () => sampleData(options.data, options.scopeId, SCHEDULES),
    inbox: () => sampleData(options.data, options.scopeId, INBOX_DATA),
    open: (generation) => remindersThread(options.scope(), options.user, generation),
  };
  return {
    state: () => scenarioState(context),
    reset: () => resetScenario(context),
    agents: [REMINDERS],
    handle: (request: Request, path: string) => handle(context, request, path),
  };
}
