import type { Passage, Scope, Thread } from "@karmi/core";
import { z } from "zod";
import { conflictOf, routeError } from "./route-error";
import { decodeSample, sampleData, type SampleDataDO } from "./sample-data";
import { VECTOR_BINDINGS } from "./vector-config";
import {
  GUIDES,
  OTHER_GUIDES,
  SEARCH_MODES,
  searchOptions,
  STARTING_GUIDES,
  STARTING_QUERY,
  toGuide,
  VECTOR_RETRIEVER,
  vectorAgent,
  VECTORS,
  type GuideDocument,
  type VectorIndex,
} from "./vectors";

interface VectorRouteOptions {
  /** Opens one of the sample Scopes by id. */
  scope: (id: string) => Scope;
  /** The sample Scope of the Thread and of the guides. */
  home: string;
  /** The second sample Scope, which has one guide with the same id and a different text. */
  other: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
  /** The external vector index, or undefined when the Worker has no Workers AI or Vectorize binding. */
  index: VectorIndex | undefined;
  /** The model id of the Agent, which gives the corpus reference that the page shows. */
  model: string;
}

/** The schema of a Passage of the Framework. The type check keeps its keys equal to `Passage`. */
const passageSchema = z.object({
  source: z.optional(z.enum(["fts", "vector", "hybrid"])),
  docId: z.string(),
  text: z.string(),
  score: z.number(),
  seq: z.optional(z.number()),
  metadata: z.optional(z.record(z.string(), z.unknown())),
} satisfies Record<keyof Passage, z.ZodType>);

/** The schema of the sample data: the last search from the page, with the Passages of each Scope. */
const vectorDataSchema = z.object({
  search: z.optional(
    z.object({
      query: z.string(),
      mode: z.enum(SEARCH_MODES),
      passages: z.array(passageSchema),
      other: z.array(passageSchema),
    }),
  ),
});

type VectorData = z.infer<typeof vectorDataSchema>;

const searchSchema = z.object({ query: z.string().trim().min(1), mode: z.enum(SEARCH_MODES) });

const PATH = `/api/scenarios/${VECTORS}`;

const MISSING = `The Worker has no ${VECTOR_BINDINGS.ai} or ${VECTOR_BINDINGS.index} binding. Deploy with vector retrieval.`;

const openThread = (options: VectorRouteOptions, generation: number): Thread =>
  options
    .scope(options.home)
    .thread({ agent: VECTORS, user: options.user, threadId: `${VECTORS}-${String(generation)}` });

/** The stored state of the scenario: the count of resets and the decoded sample data. */
interface Loaded {
  generation: number;
  data: VectorData;
}

/**
 * Loads the state of the scenario. The first load after a reset has no sample data. It then ingests the guides of
 * each Scope with the vector Retriever, which embeds each chunk, and stores empty sample data.
 */
async function load(options: VectorRouteOptions): Promise<Loaded> {
  const stub = sampleData(options.data, options.home, VECTORS);
  const stored = await stub.read();
  if (stored.data !== undefined)
    return { generation: stored.generation, data: decodeSample(vectorDataSchema, {}, stored.data) };
  const guides: Array<[string, readonly GuideDocument[]]> = [
    [options.home, STARTING_GUIDES],
    [options.other, OTHER_GUIDES],
  ];
  for (const [scopeId, documents] of guides)
    await options.scope(scopeId).knowledge(GUIDES).ingest(documents.map(toGuide), { retriever: VECTOR_RETRIEVER });
  await stub.write("{}");
  return { generation: stored.generation, data: {} };
}

const listed = (documents: readonly GuideDocument[]) =>
  documents.map(({ id, title, text }) => ({ id, title, chars: Array.from(text).length }));

/** Answers with the state of the scenario. `loaded` is the state that the route already read, when it did. */
async function scenarioState(options: VectorRouteOptions, loaded?: Loaded): Promise<Response> {
  const { index } = options;
  if (!index) {
    const stored = await sampleData(options.data, options.home, VECTORS).read();
    const thread = openThread(options, stored.generation);
    const status = await thread.status();
    return Response.json({ threadKey: thread.key, turn: { state: status.state }, missing: MISSING });
  }
  const { generation, data } = loaded ?? (await load(options));
  const thread = openThread(options, generation);
  // The status call through the identity creates the Thread. The other reads need no sequence.
  const [status, home, other] = await Promise.all([
    thread.status(),
    index.ids(options.home, GUIDES),
    index.ids(options.other, GUIDES),
  ]);
  return Response.json({
    threadKey: thread.key,
    turn: { state: status.state, paused: status.paused },
    reference: vectorAgent(options.model).spec.knowledge?.[0],
    scopes: [
      { id: options.home, documents: listed(STARTING_GUIDES), vectors: home },
      { id: options.other, documents: listed(OTHER_GUIDES), vectors: other },
    ],
    search: data.search ?? null,
    startingQuery: STARTING_QUERY,
  });
}

/** Stores new sample data and answers with the state of the scenario. */
async function store(options: VectorRouteOptions, loaded: Loaded, data: VectorData): Promise<Response> {
  await sampleData(options.data, options.home, VECTORS).write(JSON.stringify(data));
  return scenarioState(options, { ...loaded, data });
}

/** Runs one search in each sample Scope with the same mode, and keeps the Passages for the page. */
async function search(options: VectorRouteOptions, body: unknown): Promise<Response> {
  const input = searchSchema.safeParse(body);
  if (!input.success)
    return routeError(
      400,
      "http.badRequest",
      `The body must be {query, mode} with a mode of ${SEARCH_MODES.join(", ")}.`,
    );
  const { query, mode } = input.data;
  // The load comes first, because the first load after a reset ingests the guides that the search reads.
  const loaded = await load(options);
  const [passages, other] = await Promise.all(
    [options.home, options.other].map((scopeId) =>
      options.scope(scopeId).knowledge(GUIDES).search(query, searchOptions(mode)),
    ),
  );
  return store(options, loaded, {
    ...loaded.data,
    search: { query, mode, passages: passages ?? [], other: other ?? [] },
  });
}

/**
 * Deletes the vectors of the guides of the sample Scope from the external index, around the Framework. The Knowledge
 * Durable Object keeps its copy of each vector, which a rebuild writes again.
 */
async function clearIndex(options: VectorRouteOptions, index: VectorIndex): Promise<Response> {
  const loaded = await load(options);
  const ids = await index.ids(options.home, GUIDES);
  if (ids.length > 0) await index.store.deleteByIds(options.home, ids);
  return scenarioState(options, loaded);
}

/** Writes the saved vectors of the guides to the external index again. It calls no embedding model. */
async function rebuild(options: VectorRouteOptions): Promise<Response> {
  const loaded = await load(options);
  try {
    await options.scope(options.home).knowledge(GUIDES).rebuild();
  } catch (caught) {
    return conflictOf(caught, "knowledge.");
  }
  return scenarioState(options, loaded);
}

/**
 * Destroys the guides of each Scope, which deletes their vectors from the external index, then cancels and deletes the
 * Thread. The next state read ingests the guides again.
 */
async function resetScenario(options: VectorRouteOptions): Promise<Response> {
  const stub = sampleData(options.data, options.home, VECTORS);
  const stored = await stub.read();
  if (options.index)
    for (const scopeId of [options.home, options.other]) await options.scope(scopeId).knowledge(GUIDES).destroy();
  const thread = openThread(options, stored.generation);
  await thread.cancel();
  await thread.delete();
  await stub.reset();
  return scenarioState(options);
}

async function handle(options: VectorRouteOptions, request: Request, path: string): Promise<Response | undefined> {
  if (request.method !== "POST" || !path.startsWith(`${PATH}/`)) return undefined;
  const action = path.slice(PATH.length + 1);
  if (!["search", "clear", "rebuild"].includes(action)) return undefined;
  const { index } = options;
  if (!index) return routeError(503, "bindings.missing", MISSING);
  if (action === "search") return search(options, await request.json().catch(() => undefined));
  if (action === "clear") return clearIndex(options, index);
  return rebuild(options);
}

/**
 * Creates the authenticated application routes of the vector retrieval scenario. The Framework keeps the guides and
 * their vectors. The external index is a copy that a rebuild can restore.
 */
export function vectorScenarioRoutes(options: VectorRouteOptions) {
  return {
    state: () => scenarioState(options),
    reset: () => resetScenario(options),
    agents: [VECTORS],
    handle: (request: Request, path: string) => handle(options, request, path),
  };
}
