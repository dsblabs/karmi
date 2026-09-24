import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OTHER_SCOPE, SCOPE } from "../src/app";
import { env } from "cloudflare:workers";
import { SCENARIOS, viewScenario } from "../src/scenarios";
import { vectorScenarioRoutes } from "../src/vector-routes";
import { GUIDES, STARTING_QUERY, VECTORS } from "../src/vectors";
import { api as request, events } from "./client";
import { guideReplies } from "./script";
import { karmi, provider } from "./worker";
import { deletedIds } from "./vector-index";
import { setup, TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${VECTORS}`;

const passageSchema = z.looseObject({ docId: z.string(), text: z.string(), source: z.optional(z.string()) });

const stateSchema = z.object({
  threadKey: z.string(),
  reference: z.looseObject({ name: z.string(), retriever: z.string() }),
  scopes: z.tuple([
    z.object({ id: z.string(), documents: z.array(z.looseObject({ id: z.string() })), vectors: z.array(z.string()) }),
    z.object({ id: z.string(), documents: z.array(z.looseObject({ id: z.string() })), vectors: z.array(z.string()) }),
  ]),
  search: z.nullable(
    z.object({
      query: z.string(),
      mode: z.string(),
      passages: z.array(passageSchema),
      other: z.array(passageSchema),
    }),
  ),
});

type State = z.infer<typeof stateSchema>;

const state = async (): Promise<State> => stateSchema.parse(await (await api("GET", PATH)).json());

/** Sends a scenario action and returns the new state. The action must succeed. */
async function act(action: string, body?: unknown): Promise<State> {
  const response = await api("POST", `${PATH}/${action}`, body);
  expect(response.status).toBe(200);
  return stateSchema.parse(await response.json());
}

/** Searches both sample Scopes from the route and returns the result of the search. */
async function search(query: string, mode: "keyword" | "vector" | "hybrid") {
  const result = (await act("search", { query, mode })).search;
  if (!result) throw new Error("The state has no search.");
  return result;
}

const docIds = (passages: Array<{ docId: string }>) => passages.map((passage) => passage.docId);

describe("the vector retrieval scenario", () => {
  beforeEach(async () => {
    expect((await api("POST", `${PATH}/reset`)).status).toBe(200);
  });

  it("ingests the guides of each Scope with the vector Retriever and mirrors each vector to the index", async () => {
    const now = await state();
    expect(now.reference).toMatchObject({ name: GUIDES, retriever: "semantic", settings: { mode: "hybrid" } });
    expect(now.scopes[0]).toMatchObject({ id: SCOPE });
    expect(now.scopes[0].vectors).toHaveLength(5);
    expect(now.scopes[1]).toMatchObject({ id: OTHER_SCOPE, documents: [{ id: "returns" }] });
    expect(now.scopes[1].vectors).toHaveLength(1);
    // The index keeps the opaque ids of the Framework. No id is the document id.
    expect(now.scopes[0].vectors).not.toContain("returns");
    expect(await karmi.scope(SCOPE).knowledge.list()).toContain(GUIDES);
  });

  it("finds a guide by its meaning where a keyword search finds nothing", async () => {
    expect((await search(STARTING_QUERY, "keyword")).passages).toEqual([]);
    const vector = await search(STARTING_QUERY, "vector");
    expect(vector.passages[0]).toMatchObject({ docId: "returns", source: "vector", metadata: { title: "Returns" } });
    const hybrid = await search(STARTING_QUERY, "hybrid");
    expect(hybrid.passages[0]).toMatchObject({ docId: "returns", source: "hybrid" });
    expect(hybrid.passages.length).toBeLessThanOrEqual(3);
  });

  it("keeps the vectors of each Scope apart, also for a guide with the same id", async () => {
    const result = await search(STARTING_QUERY, "vector");
    expect(result.passages[0]?.text).toContain("30 days");
    expect(docIds(result.other)).toEqual(["returns"]);
    expect(result.other[0]?.text).toContain("shop credit only");
    expect(result.passages.map((passage) => passage.text).join(" ")).not.toContain("shop credit only");
  });

  it("rebuilds a cleared index from the Knowledge of the Framework with the same opaque ids", async () => {
    const before = (await state()).scopes[0].vectors;
    const cleared = await act("clear");
    expect(cleared.scopes[0].vectors).toEqual([]);
    // The second Scope keeps its vectors, because the clear acts in the first Scope only.
    expect(cleared.scopes[1].vectors).toHaveLength(1);
    expect((await search(STARTING_QUERY, "vector")).passages).toEqual([]);
    // The keyword search reads the Framework's chunks, not the index.
    expect(docIds((await search("refunds", "keyword")).passages)).toEqual(["returns"]);

    const rebuilt = await act("rebuild");
    expect(rebuilt.scopes[0].vectors.toSorted()).toEqual(before.toSorted());
    expect((await search(STARTING_QUERY, "vector")).passages[0]).toMatchObject({ docId: "returns" });
  });

  it("gives the Agent the hybrid search Tool of its Agent Spec", async () => {
    provider.script(guideReplies);
    const key = (await state()).threadKey;
    const ended = (log: ThreadEvent[]) => log.filter((event) => event.type === "turn.completed").length;
    const sent = await api("POST", `/threads/${key}/turns`, {
      kind: "message",
      parts: [{ type: "text", text: "How long do beans stay fresh?" }],
    });
    expect(sent.status).toBe(202);
    let log: ThreadEvent[] = [];
    await expect.poll(async () => ended((log = await events(key))), { timeout: 10_000 }).toBe(1);
    expect(log).toContainEqual(expect.objectContaining({ type: "tool.call", name: "search_guides" }));
    const answer = log.filter((event) => event.type === "message.part").at(-1);
    expect(answer).toMatchObject({ block: { text: expect.stringContaining("(storage, hybrid)") } });
  });

  it("deletes the vectors of each Scope from the index on reset, then ingests the guides again", async () => {
    const before = await state();
    await act("search", { query: STARTING_QUERY, mode: "vector" });
    deletedIds.length = 0;
    const response = await api("POST", `${PATH}/reset`);
    expect(response.status).toBe(200);
    // The destroy of each corpus deletes each vector that the Framework wrote, in both Scopes.
    expect(deletedIds.toSorted()).toEqual(
      [
        ...before.scopes[0].vectors.map((id) => `${SCOPE}/${id}`),
        ...before.scopes[1].vectors.map((id) => `${OTHER_SCOPE}/${id}`),
      ].toSorted(),
    );
    const after = stateSchema.parse(await response.json());
    expect(after.threadKey).not.toBe(before.threadKey);
    expect(after.search).toBeNull();
    expect(after.scopes[0].vectors).toHaveLength(5);
    expect(after.scopes[1].vectors).toHaveLength(1);
  });

  it("refuses a search without a known mode", async () => {
    expect((await api("POST", `${PATH}/search`, { query: STARTING_QUERY, mode: "fuzzy" })).status).toBe(400);
    expect((await api("POST", `${PATH}/search`, { query: " ", mode: "vector" })).status).toBe(400);
  });

  it("is unavailable without Workers AI and Vectorize, and ingests nothing", async () => {
    const scenario = SCENARIOS.find((item) => item.id === VECTORS);
    if (!scenario) throw new Error("No vector retrieval scenario.");
    expect(viewScenario(scenario, setup, { hasLoader: true })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("select vector retrieval"),
    });
    const routes = vectorScenarioRoutes({
      scope: (id) => karmi.scope(id),
      home: "vector-missing",
      other: OTHER_SCOPE,
      user: "operator",
      data: env.PLAYGROUND_DATA,
      index: undefined,
      model: "fake/model",
    });
    expect(await (await routes.state()).json()).toMatchObject({
      missing: expect.stringContaining("KNOWLEDGE_VECTORS"),
    });
    const refused = await routes.handle(
      new Request(`https://playground.test${PATH}/rebuild`, { method: "POST" }),
      `${PATH}/rebuild`,
    );
    expect(refused?.status).toBe(503);
    expect((await routes.reset()).status).toBe(200);
    expect(await karmi.scope("vector-missing").knowledge.list()).toEqual([]);
  });
});
