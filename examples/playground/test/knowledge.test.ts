import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { KNOWLEDGE } from "../src/app";
import { BULK_DOCUMENTS } from "../src/librarian";
import { api as request, events } from "./client";
import { librarianReplies } from "./script";
import { clock, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${KNOWLEDGE}`;

const passageSchema = z.looseObject({
  docId: z.string(),
  text: z.string(),
  score: z.number(),
  metadata: z.optional(z.record(z.string(), z.unknown())),
});

const corpusSchema = z.object({
  name: z.string(),
  mode: z.enum(["search", "inline"]),
  tool: z.optional(z.string()),
  documents: z.array(z.object({ id: z.string(), title: z.string(), chars: z.number() })),
  inline: z.optional(z.union([z.object({ text: z.string() }), z.object({ error: z.string() })])),
});

const stateSchema = z.object({
  threadKey: z.string(),
  turn: z.object({ state: z.string() }),
  corpora: z.tuple([corpusSchema, corpusSchema]),
  known: z.array(z.string()),
  inlineLimit: z.number(),
  bulkSize: z.number(),
  job: z.nullable(z.object({ id: z.string(), state: z.string(), completed: z.number(), total: z.number() })),
  search: z.nullable(z.object({ query: z.string(), passages: z.array(passageSchema) })),
});

type State = z.infer<typeof stateSchema>;

/** Reads the state of the scenario through its route. */
const state = async (): Promise<State> => stateSchema.parse(await (await api("GET", PATH)).json());

/** Sends a scenario action and returns the new state. The action must succeed. */
async function act(action: string, body?: unknown): Promise<State> {
  const response = await api("POST", `${PATH}/${action}`, body);
  expect(response.status).toBe(200);
  return stateSchema.parse(await response.json());
}

const handbook = (now: State) => now.corpora[0];
const notices = (now: State) => now.corpora[1];
const ids = (now: State, corpus: "handbook" | "notices") =>
  (corpus === "handbook" ? handbook(now) : notices(now)).documents.map((doc) => doc.id);

/** Searches the handbook from the route and returns the Passages. */
const search = async (query: string) => (await act("search", { query })).search?.passages ?? [];

const ended = (log: ThreadEvent[]) =>
  log.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").length;

/** Sends one message to the Thread of the scenario and returns the log after the Turn ends. */
async function run(text: string): Promise<ThreadEvent[]> {
  const key = (await state()).threadKey;
  const before = ended(await events(key));
  const sent = await api("POST", `/threads/${key}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
  let log: ThreadEvent[] = [];
  await expect.poll(async () => ended((log = await events(key))), { timeout: 10_000 }).toBe(before + 1);
  return log;
}

/** The final answer of the Agent in a log. */
const answer = (log: ThreadEvent[]) =>
  log
    .filter((event) => event.type === "message.part")
    .map((event) => (event.block.type === "text" ? event.block.text : ""))
    .at(-1);

/** Moves the Clock past the alarms of a bulk ingest until its Job completes. */
async function completeBulk(): Promise<State> {
  let now = await state();
  for (let tick = 0; tick < 10 && now.job?.state !== "completed"; tick++) {
    await clock.advance(1000);
    now = await state();
  }
  return now;
}

const SEARCH = "How many days does a customer have to return a product? Search the handbook.";
const INLINE = "Is the shop open on Sunday?";

beforeEach(async () => {
  provider.script(librarianReplies);
  const reset = await api("POST", `${PATH}/reset`);
  expect(reset.status).toBe(200);
});

describe("the state of the scenario", () => {
  it("starts with the starting documents in two corpora, which the Scope lists", async () => {
    const now = await state();
    expect(now.turn.state).toBe("idle");
    expect(handbook(now)).toMatchObject({ name: "handbook", mode: "search", tool: "search_handbook" });
    expect(ids(now, "handbook")).toEqual(["refunds", "beans", "allergens"]);
    expect(notices(now)).toMatchObject({ name: "notices", mode: "inline" });
    expect(ids(now, "notices")).toEqual(["hours", "service"]);
    expect(notices(now).inline).toEqual({ text: expect.stringContaining("closed on Sunday") });
    expect(now.known).toEqual(["handbook", "notices"]);
    expect(now.inlineLimit).toBe(32_000);
    expect(now.bulkSize).toBe(BULK_DOCUMENTS);
    expect(now.job).toBeNull();
    expect(now.search).toBeNull();
  });
});

describe("search and the search Tool", () => {
  it("returns the Passages of the handbook with their document ids and metadata", async () => {
    const passages = await search("return product");
    expect(passages[0]).toMatchObject({ docId: "refunds", metadata: { title: "Refund policy" } });
    expect(passages[0]?.text).toContain("30 days");
    expect((await state()).search).toMatchObject({ query: "return product" });
  });

  it("gives the Agent the same Passages through search_handbook, and the answer names the document", async () => {
    const log = await run(SEARCH);
    expect(log).toContainEvent({ type: "tool.call", name: "search_handbook", input: { query: "return product" } });
    const result = log.find((event) => event.type === "tool.result" && event.name === "search_handbook");
    const text =
      result?.type === "tool.result" ? result.content.map((block) => ("text" in block ? block.text : "")).join("") : "";
    // The Tool returns the Passages of the Retriever as JSON.
    expect(z.array(passageSchema).parse(JSON.parse(text))).toEqual(await search("return product"));
    expect(answer(log)).toBe(
      "The handbook says: A customer can return a product within 30 days of the purchase. The shop refunds the price to the original payment method. (refunds)",
    );
    // The Tool is read-only, thus no Approval stops it.
    expect(log.filter((event) => event.type === "approval.requested")).toEqual([]);
  });

  it("finds the new text after an update of a document", async () => {
    const now = await act("ingest", {
      corpus: "handbook",
      id: "refunds",
      title: "Refund policy",
      text: "A customer can return a product within 14 days of the purchase.",
    });
    expect(ids(now, "handbook")).toEqual(["refunds", "beans", "allergens"]);
    const passages = await search("return product");
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toContain("14 days");
    expect(answer(await run(SEARCH))).toContain("14 days");
  });

  it("adds a new document to the list and to the corpus", async () => {
    const now = await act("ingest", { corpus: "handbook", id: "grinder", text: "Clean the grinder each Friday." });
    expect(handbook(now).documents.at(-1)).toEqual({ id: "grinder", title: "", chars: 30 });
    expect((await search("grinder"))[0]?.docId).toBe("grinder");
  });

  it("refuses a body that names no corpus of the scenario", async () => {
    expect((await api("POST", `${PATH}/ingest`, { corpus: "other", id: "x", text: "y" })).status).toBe(400);
    expect((await api("POST", `${PATH}/search`, {})).status).toBe(400);
    expect((await api("POST", `${PATH}/delete`, { corpus: "handbook" })).status).toBe(400);
    expect((await api("POST", `${PATH}/destroy`, {})).status).toBe(400);
  });
});

describe("inline Knowledge", () => {
  it("reaches the Agent in its Prompt, with no Tool call", async () => {
    const log = await run(INLINE);
    expect(answer(log)).toBe("The shop is closed on Sunday.");
    expect(log.filter((event) => event.type === "tool.call")).toEqual([]);
    const system = provider.requests.at(-1)?.system ?? "";
    expect(system).toContain("# Knowledge: notices");
    expect(system).toContain("The shop is closed on Sunday.");
    // The search corpus is a Tool, not a part of the Prompt.
    expect(system).not.toContain("# Knowledge: handbook");
    expect(provider.requests.at(-1)?.tools?.map((tool) => tool.name)).toContain("search_handbook");
  });

  it("is gone from the Prompt after a delete of the notice", async () => {
    const now = await act("delete", { corpus: "notices", id: "hours" });
    expect(ids(now, "notices")).toEqual(["service"]);
    expect(notices(now).inline).toEqual({ text: expect.not.stringContaining("Sunday") });
    expect(answer(await run(INLINE))).toBe("I have no notice about Sunday.");
  });

  it("fails the Turn when the corpus is over the inline limit", async () => {
    const now = await act("ingest", { corpus: "notices", id: "long", text: "x".repeat(32_001) });
    expect(notices(now).inline).toEqual({ error: expect.stringContaining("inline limit is 32000") });
    const log = await run(INLINE);
    expect(log).toContainEvent({ type: "turn.failed" });
    expect(JSON.stringify(log)).toContain("inline limit is 32000");
    // The delete of the long document makes the corpus usable again.
    await act("delete", { corpus: "notices", id: "long" });
    expect(answer(await run(INLINE))).toBe("The shop is closed on Sunday.");
  });
});

describe("a bulk ingest", () => {
  it("runs as a Job whose completed documents are searchable", async () => {
    const started = await act("bulk");
    expect(started.job).toMatchObject({ state: "pending", completed: 0, total: BULK_DOCUMENTS });
    expect(handbook(started).documents).toHaveLength(3 + BULK_DOCUMENTS);
    // Each other write waits for the Job.
    const busy = await api("POST", `${PATH}/ingest`, { corpus: "handbook", id: "x", text: "y" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "knowledge.busy" } });
    expect((await api("POST", `${PATH}/reset`)).status).toBe(409);

    await clock.advance(1000);
    const partial = await state();
    expect(partial.job).toMatchObject({ state: "pending", completed: 8 });
    // A search sees the documents that the Job committed.
    expect((await search("lot 3")).some((passage) => passage.docId === "lot-3")).toBe(true);
    expect((await search("lot 12")).some((passage) => passage.docId === "lot-12")).toBe(false);

    const done = await completeBulk();
    expect(done.job).toMatchObject({ state: "completed", completed: BULK_DOCUMENTS, total: BULK_DOCUMENTS });
    expect((await search("lot 12"))[0]).toMatchObject({ docId: "lot-12", metadata: { title: "Bean lot 12" } });
    const log = await run("Which shelf holds bean lot 12? Search the handbook.");
    expect(log).toContainEvent({ type: "tool.call", name: "search_handbook", input: { query: "lot 12" } });
    expect(answer(log)).toContain("(lot-12)");
  });

  it("can run again after it completed", async () => {
    const first = (await act("bulk")).job?.id;
    await completeBulk();
    const again = await act("bulk");
    expect(again.job).toMatchObject({ state: "pending" });
    expect(again.job?.id).not.toBe(first);
    const done = await completeBulk();
    expect(done.job).toMatchObject({ state: "completed" });
    expect(handbook(done).documents).toHaveLength(3 + BULK_DOCUMENTS);
  });
});

describe("deletion and cleanup", () => {
  it("removes a deleted document from the search", async () => {
    const now = await act("delete", { corpus: "handbook", id: "refunds" });
    expect(ids(now, "handbook")).toEqual(["beans", "allergens"]);
    expect(await search("return product")).toEqual([]);
    expect(answer(await run(SEARCH))).toBe("The handbook has nothing about that.");
  });

  it("removes a destroyed corpus from the Scope", async () => {
    const now = await act("destroy", { corpus: "handbook" });
    expect(ids(now, "handbook")).toEqual([]);
    expect(now.known).toEqual(["notices"]);
    expect(await search("return product")).toEqual([]);
    // The Tool stays, because the Agent Spec names the corpus. The search finds nothing.
    expect(answer(await run(SEARCH))).toBe("The handbook has nothing about that.");
  });

  it("is repeatable", async () => {
    await act("delete", { corpus: "handbook", id: "refunds" });
    expect((await api("POST", `${PATH}/delete`, { corpus: "handbook", id: "refunds" })).status).toBe(200);
    await act("destroy", { corpus: "handbook" });
    expect((await api("POST", `${PATH}/destroy`, { corpus: "handbook" })).status).toBe(200);
  });
});

describe("the reset of the scenario", () => {
  it("destroys each corpus, deletes the Thread, restores the starting documents and keeps the setup", async () => {
    await act("ingest", { corpus: "handbook", id: "grinder", text: "Clean the grinder each Friday." });
    await act("delete", { corpus: "notices", id: "hours" });
    await search("grinder");
    const before = await state();
    await run(SEARCH);
    const after = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(after.threadKey).not.toBe(before.threadKey);
    expect((await api("GET", `/threads/${before.threadKey}`)).status).toBe(404);
    expect(ids(after, "handbook")).toEqual(["refunds", "beans", "allergens"]);
    expect(ids(after, "notices")).toEqual(["hours", "service"]);
    expect(after.known).toEqual(["handbook", "notices"]);
    expect(after.search).toBeNull();
    expect(after.job).toBeNull();
    expect(await search("grinder")).toEqual([]);
    expect((await search("return product"))[0]?.text).toContain("30 days");
    expect(await (await api("GET", "/api/playground")).json()).toMatchObject({
      provider: { id: "openrouter", model: "test/model" },
    });
  });

  it("waits for a pending bulk ingest, then resets", async () => {
    await act("bulk");
    const refused = await api("POST", `${PATH}/reset`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "knowledge.busy" } });
    // The refused reset changed nothing: the Job goes on.
    expect((await state()).job).toMatchObject({ state: "pending" });
    await completeBulk();
    const after = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(after.job).toBeNull();
    expect(ids(after, "handbook")).toEqual(["refunds", "beans", "allergens"]);
  });

  it("does not change the Memory scenario", async () => {
    const memory: unknown = await (await api("GET", "/api/scenarios/memory")).json();
    await api("POST", `${PATH}/reset`);
    expect(await (await api("GET", "/api/scenarios/memory")).json()).toEqual(memory);
  });
});
