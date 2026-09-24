import { defineAgent, defineTool } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { errorResult } from "./results";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the Turn control scenario. */
export const TURNS = "turns";
/** The id of the Agent of the Turn control scenario. */
export const DISPATCH = "dispatch";

/** The Steps that one budget window of the Agent gives. A small number makes the continuation Approval quick. */
export const MAX_STEPS = 6;

/** The schema of the sample dispatch system. */
export const dispatchSchema = z.object({
  parcels: z.array(z.object({ id: z.string(), item: z.string(), packed: z.boolean() })),
  /** The courier booking that a Job runs, or absent while no booking exists. */
  booking: z
    .object({
      /** The id that `thread.jobs` reports the outcome under. */
      jobId: z.string(),
      note: z.string(),
      parcels: z.number(),
      status: z.enum(["waiting", "collected", "failed"]),
    })
    .optional(),
});

/** The sample dispatch system of the Turn control scenario. */
export type Dispatch = z.infer<typeof dispatchSchema>;

/** The dispatch that the scenario starts with and that a reset restores. */
export const STARTING_DISPATCH: Dispatch = {
  parcels: [
    { id: "P-1", item: "Stoneware mug", packed: false },
    { id: "P-2", item: "Gooseneck kettle", packed: false },
    { id: "P-3", item: "Ceramic pour-over coffee set", packed: false },
    { id: "P-4", item: "Bag of espresso beans", packed: false },
  ],
};

/** The prompts that the scenario suggests. The operator can edit each one. */
export const DISPATCH_PROMPTS = [
  {
    label: "Budget",
    text: "Pack every parcel of today's dispatch, one parcel in each call. Then list the parcels again to check that each one is packed.",
  },
  { label: "Steering", text: "Change of plan: pack the mug parcel only, then stop." },
  { label: "Job", text: "Pack parcel P-1, then book the courier for today." },
];

/** Decodes the stored sample data. Data that is absent or not valid gives the starting dispatch. */
export const decodeDispatch = (data: string | undefined): Dispatch =>
  decodeSample(dispatchSchema, STARTING_DISPATCH, data);

/** What the operator reports for a courier booking that waits. */
export type JobReport = "collected" | "failed";

/** Decodes the body of the Job route. A body of a different shape gives undefined. */
export function decodeReport(body: unknown): JobReport | undefined {
  if (typeof body !== "object" || body === null || !("report" in body)) return undefined;
  return body.report === "collected" || body.report === "failed" ? body.report : undefined;
}

/** Returns the dispatch with the outcome of the courier booking written to it. */
export function reportBooking(dispatch: Dispatch, report: JobReport): Dispatch {
  const { booking } = dispatch;
  return booking ? { ...dispatch, booking: { ...booking, status: report } } : dispatch;
}

const dispatchSystem = (scope: string) => sampleData(env.PLAYGROUND_DATA, scope, TURNS);
const readDispatch = async (scope: string) => decodeDispatch((await dispatchSystem(scope).read()).data);

/** Reads the parcels. The Policy allows it, because it changes nothing. */
export const listParcels = defineTool({
  name: "list_parcels",
  description: "List the parcels of today's dispatch and the state of each one",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async execute(_input, { scope }) {
    return JSON.stringify((await readDispatch(scope)).parcels);
  },
});

/** Packs one parcel. A batch of calls in one model answer is one Step of the budget. */
export const packParcel = defineTool({
  name: "pack_parcel",
  description: "Pack one parcel of today's dispatch",
  input: z.object({ parcelId: z.string().describe("The parcel id, for example P-1") }),
  annotations: { destructiveHint: false },
  async execute({ parcelId }, { scope }) {
    const stub = dispatchSystem(scope);
    const dispatch = decodeDispatch((await stub.read()).data);
    const parcel = dispatch.parcels.find((item) => item.id === parcelId);
    if (!parcel) return errorResult(`There is no parcel ${parcelId}.`);
    if (parcel.packed) return errorResult(`Parcel ${parcelId} is packed already.`);
    await stub.write(
      JSON.stringify({
        ...dispatch,
        parcels: dispatch.parcels.map((item) => (item.id === parcelId ? { ...item, packed: true } : item)),
      } satisfies Dispatch),
    );
    return `Packed parcel ${parcelId} with the ${parcel.item}.`;
  },
});

/**
 * Books the courier and gives the call to a Job. The booking exists in the sample courier system at once, and
 * the tool Step parks until the operator reports the outcome of the Job.
 */
export const bookCourier = defineTool({
  name: "book_courier",
  description: "Book the courier to collect the packed parcels. The courier answers later.",
  input: z.object({ note: z.string().describe("What the courier must know about the collection") }),
  annotations: { destructiveHint: false },
  async execute({ note }, { scope }) {
    const stub = dispatchSystem(scope);
    const dispatch = decodeDispatch((await stub.read()).data);
    const packed = dispatch.parcels.filter((parcel) => parcel.packed).length;
    if (packed === 0) return errorResult("No parcel is packed. Pack a parcel before you book the courier.");
    if (dispatch.booking) return errorResult("The sample courier system has a booking already.");
    const jobId = crypto.randomUUID();
    await stub.write(JSON.stringify({ ...dispatch, booking: { jobId, note, parcels: packed, status: "waiting" } }));
    return { pending: jobId };
  },
});

/** Defines the Agent of the Turn control scenario for the model that setup selected. */
export const dispatchAgent = (model: string) =>
  defineAgent({
    agentId: DISPATCH,
    name: "Dispatch desk",
    instructions: [
      {
        text: "You pack parcels at the dispatch desk of a small shop. Pack one parcel in each call. Book the courier only when the operator asks for it. Answer in one or two sentences.",
      },
    ],
    model: { id: model },
    tools: ["list_parcels", "pack_parcel", "book_courier"],
    // The grant is the budget of one window. The Turn parks for a `continue` Approval when it spends the window.
    capabilities: { longRunning: { maxSteps: MAX_STEPS } },
    policy: [{ match: { tool: ["list_parcels", "pack_parcel", "book_courier"] }, effect: "allow" }],
  });
