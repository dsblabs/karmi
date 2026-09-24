import { KarmiError, KNOWLEDGE_INLINE_LIMIT, type KnowledgeJob, type Scope, type Thread } from "@karmi/core";
import { z } from "zod";
import {
  BULK_DOCUMENTS,
  bulkDocuments,
  CORPORA,
  decodeKnowledgeData,
  KNOWLEDGE,
  LIBRARIAN,
  STARTING_DOCUMENTS,
  toKnowledgeDocument,
  type CorpusName,
  type KnowledgeData,
  type SampleDocument,
} from "./librarian";
import { conflictOf, routeError } from "./route-error";
import { sampleData, type SampleDataDO } from "./sample-data";

interface KnowledgeRouteOptions {
  scope: () => Scope;
  scopeId: string;
  user: string;
  data: DurableObjectNamespace<SampleDataDO>;
}

const corpusName = z.enum(CORPORA.map((corpus) => corpus.name));

const ingestSchema = z.object({
  corpus: corpusName,
  id: z.string().min(1).max(512),
  title: z.string().default(""),
  text: z.string().min(1),
});
const documentRefSchema = z.object({ corpus: corpusName, id: z.string().min(1) });
const corpusRefSchema = z.object({ corpus: corpusName });
const searchSchema = z.object({ query: z.string().min(1) });

/** Decodes a body with one of the schemas of the routes. Returns undefined for a body that does not match. */
function decodeBody<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const PATH = `/api/scenarios/${KNOWLEDGE}`;

/** The id of the bulk ingest Job with this number since the reset. The generation keeps it unique after a reset. */
const bulkJobId = (generation: number, n: number) => `bulk-${String(generation)}-${String(n)}`;

const openThread = (options: KnowledgeRouteOptions, generation: number): Thread =>
  options.scope().thread({ agent: LIBRARIAN, user: options.user, threadId: `${LIBRARIAN}-${String(generation)}` });

/** The stored state of the scenario: the count of resets and the decoded sample data. */
interface Loaded {
  generation: number;
  data: KnowledgeData;
}

/**
 * Runs one call to the Knowledge API of the Framework. Returns an error answer with the code of a Knowledge
 * error, for example `knowledge.busy` while a bulk ingest is pending, and nothing after a successful call.
 * Each other error is thrown.
 */
async function attempt(call: () => Promise<unknown>): Promise<Response | undefined> {
  try {
    await call();
    return undefined;
  } catch (caught) {
    return conflictOf(caught, "knowledge.");
  }
}

/**
 * Loads the state of the scenario. The first load after a reset has no sample data. It then ingests the starting
 * documents into the corpora and stores the starting sample data, thus the scenario is ready when the page opens.
 */
async function load(options: KnowledgeRouteOptions): Promise<Loaded> {
  const stub = sampleData(options.data, options.scopeId, KNOWLEDGE);
  const stored = await stub.read();
  if (stored.data !== undefined) return { generation: stored.generation, data: decodeKnowledgeData(stored.data) };
  const data = decodeKnowledgeData(undefined);
  for (const [name, documents] of Object.entries(STARTING_DOCUMENTS))
    await options.scope().knowledge(name).ingest(documents.map(toKnowledgeDocument));
  await stub.write(JSON.stringify(data));
  return { generation: stored.generation, data };
}

/** Stores new sample data and answers with the state of the scenario. */
async function store(options: KnowledgeRouteOptions, loaded: Loaded, data: KnowledgeData): Promise<Response> {
  await sampleData(options.data, options.scopeId, KNOWLEDGE).write(JSON.stringify(data));
  return scenarioState(options, { ...loaded, data });
}

/** The sample data with the document list of one corpus replaced. */
const withDocuments = (data: KnowledgeData, corpus: CorpusName, documents: SampleDocument[]): KnowledgeData => ({
  ...data,
  documents: { ...data.documents, [corpus]: documents },
});

/** The progress of the last bulk ingest Job, or null when none ran since the reset or a destroy removed it. */
async function lastJob(options: KnowledgeRouteOptions, { generation, data }: Loaded) {
  if (data.bulk === 0) return null;
  const id = bulkJobId(generation, data.bulk);
  try {
    const job: KnowledgeJob = await options.scope().knowledge("handbook").jobs.get(id);
    return { id, ...job };
  } catch (caught) {
    if (caught instanceof KarmiError && caught.code === "job.notFound") return null;
    throw caught;
  }
}

/** The full text that an inline corpus gives to the Prompt, or the error of a corpus over the inline limit. */
async function inlineOf(scope: Scope, name: string): Promise<{ text: string } | { error: string }> {
  try {
    return { text: await scope.knowledge(name).inline() };
  } catch (caught) {
    if (caught instanceof KarmiError && caught.code === "knowledge.inlineLimit") return { error: caught.message };
    throw caught;
  }
}

/** Answers with the state of the scenario. `loaded` is the state that the route already read, when it did. */
async function scenarioState(options: KnowledgeRouteOptions, loaded?: Loaded): Promise<Response> {
  const current = loaded ?? (await load(options));
  const { generation, data } = current;
  const scope = options.scope();
  const thread = openThread(options, generation);
  // The status call through the identity creates the Thread. The other reads need no sequence.
  const [status, known, job, corpora] = await Promise.all([
    thread.status(),
    scope.knowledge.list(),
    lastJob(options, current),
    Promise.all(
      CORPORA.map(async (corpus) => ({
        ...corpus,
        ...(corpus.mode === "search" && { tool: `search_${corpus.name}` }),
        documents: (data.documents[corpus.name] ?? []).map(({ id, title, text }) => ({
          id,
          title,
          chars: Array.from(text).length,
        })),
        ...(corpus.mode === "inline" && { inline: await inlineOf(scope, corpus.name) }),
      })),
    ),
  ]);
  return Response.json({
    threadKey: thread.key,
    turn: { state: status.state, paused: status.paused },
    corpora,
    known,
    inlineLimit: KNOWLEDGE_INLINE_LIMIT,
    bulkSize: BULK_DOCUMENTS,
    job,
    search: data.search ?? null,
  });
}

/** Ingests one document. A document with a known id replaces the old text, and the list keeps its position. */
async function ingest(options: KnowledgeRouteOptions, body: unknown): Promise<Response> {
  const input = decodeBody(ingestSchema, body);
  if (!input) return routeError(400, "http.badRequest", "The body must be {corpus, id, text} with an optional title.");
  const { corpus, ...document } = input;
  const refused = await attempt(() =>
    options
      .scope()
      .knowledge(corpus)
      .ingest([toKnowledgeDocument(document)]),
  );
  if (refused) return refused;
  const loaded = await load(options);
  const list = loaded.data.documents[corpus] ?? [];
  const index = list.findIndex((item) => item.id === document.id);
  const documents = index === -1 ? [...list, document] : list.with(index, document);
  return store(options, loaded, withDocuments(loaded.data, corpus, documents));
}

/** Searches the handbook from code, as the search Tool does, and keeps the Passages for the page. */
async function search(options: KnowledgeRouteOptions, body: unknown): Promise<Response> {
  const input = decodeBody(searchSchema, body);
  if (!input) return routeError(400, "http.badRequest", "The body must be {query}.");
  const passages = await options.scope().knowledge("handbook").search(input.query);
  const loaded = await load(options);
  return store(options, loaded, { ...loaded.data, search: { query: input.query, passages } });
}

/** Starts a bulk ingest into the handbook. The Framework runs it as a Job, and the state shows its progress. */
async function bulk(options: KnowledgeRouteOptions): Promise<Response> {
  const loaded = await load(options);
  const documents = bulkDocuments();
  const n = loaded.data.bulk + 1;
  const refused = await attempt(() =>
    options
      .scope()
      .knowledge("handbook")
      .ingest(documents.map(toKnowledgeDocument), {
        jobId: bulkJobId(loaded.generation, n),
      }),
  );
  if (refused) return refused;
  const kept = (loaded.data.documents.handbook ?? []).filter((item) => !documents.some((doc) => doc.id === item.id));
  return store(options, loaded, withDocuments({ ...loaded.data, bulk: n }, "handbook", [...kept, ...documents]));
}

/** Deletes one document from its corpus. */
async function remove(options: KnowledgeRouteOptions, body: unknown): Promise<Response> {
  const ref = decodeBody(documentRefSchema, body);
  if (!ref) return routeError(400, "http.badRequest", "The body must be {corpus, id}.");
  const refused = await attempt(() => options.scope().knowledge(ref.corpus).delete([ref.id]));
  if (refused) return refused;
  const loaded = await load(options);
  const documents = (loaded.data.documents[ref.corpus] ?? []).filter((item) => item.id !== ref.id);
  return store(options, loaded, withDocuments(loaded.data, ref.corpus, documents));
}

/** Destroys one corpus. It leaves the list of corpora of the Scope. The sample list of the corpus is empty. */
async function destroy(options: KnowledgeRouteOptions, body: unknown): Promise<Response> {
  const ref = decodeBody(corpusRefSchema, body);
  if (!ref) return routeError(400, "http.badRequest", "The body must be {corpus}.");
  const refused = await attempt(() => options.scope().knowledge(ref.corpus).destroy());
  if (refused) return refused;
  const loaded = await load(options);
  return store(options, loaded, withDocuments(loaded.data, ref.corpus, []));
}

/**
 * Destroys each corpus, then cancels and deletes the Thread and restores the starting documents. The Framework
 * refuses a destroy while a bulk ingest is pending. The reset then answers with `knowledge.busy` before it
 * destroys the first corpus, thus a refused reset changes nothing.
 */
async function resetScenario(options: KnowledgeRouteOptions): Promise<Response> {
  const loaded = await load(options);
  if ((await lastJob(options, loaded))?.state === "pending")
    return Response.json(
      {
        error: {
          code: "knowledge.busy",
          message: "A bulk ingest Job is pending. The Framework refuses a destroy until it completes.",
        },
      },
      { status: 409 },
    );
  for (const corpus of CORPORA) {
    const refused = await attempt(() => options.scope().knowledge(corpus.name).destroy());
    if (refused) return refused;
  }
  const thread = openThread(options, loaded.generation);
  await thread.cancel();
  await thread.delete();
  await sampleData(options.data, options.scopeId, KNOWLEDGE).reset();
  return scenarioState(options);
}

async function handle(options: KnowledgeRouteOptions, request: Request, path: string): Promise<Response | undefined> {
  if (request.method !== "POST" || !path.startsWith(`${PATH}/`)) return undefined;
  const body = () => request.json().catch(() => undefined);
  switch (path.slice(PATH.length + 1)) {
    case "ingest":
      return ingest(options, await body());
    case "search":
      return search(options, await body());
    case "bulk":
      return bulk(options);
    case "delete":
      return remove(options, await body());
    case "destroy":
      return destroy(options, await body());
    default:
      return undefined;
  }
}

/**
 * Creates the authenticated application routes of the Knowledge scenario. The scenario keeps the list of the
 * documents that the operator ingested as its sample data. The Framework keeps the corpora.
 */
export function knowledgeScenarioRoutes(options: KnowledgeRouteOptions) {
  return {
    state: () => scenarioState(options),
    reset: () => resetScenario(options),
    agents: [LIBRARIAN],
    handle: (request: Request, path: string) => handle(options, request, path),
  };
}
