import type { ThreadEvent } from "@karmi/core";
import { reply } from "@karmi/core/testing";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SCOPE } from "../src/app";
import { COMPACTION, CONTEXT, LEDGER, ledgerSchema, STARTING_LEDGER } from "../src/ledger";
import { sampleData } from "../src/sample-data";
import { api as request, events } from "./client";
import { clock, provider } from "./worker";
import { TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = "/api/scenarios/compaction";

const stateSchema = z.looseObject({
  threadKey: z.string(),
  ledger: ledgerSchema.extend({ held: z.boolean() }),
  context: z.object({ window: z.number(), reserveTokens: z.number(), keepRecentTokens: z.number() }),
  turn: z.looseObject({ state: z.string(), paused: z.optional(z.string()) }),
});

/** Reads the state of the scenario through its route. */
const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());

/** Holds or releases the sample ledger through its route. `from` holds it once it has this number of entries. */
async function hold(held: boolean, from?: number) {
  const answer = await api("POST", `${PATH}/hold`, { held, ...(from !== undefined && { from }) });
  expect(answer.status).toBe(200);
  return stateSchema.parse(await answer.json());
}

/** Waits until the log of the Thread has this number of events of this type and returns the log. */
async function until(key: string, type: ThreadEvent["type"], count = 1): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).filter((event) => event.type === type).length, { timeout: 10_000 })
    .toBe(count);
  return log;
}

/** Sends one message to the Thread of the scenario. */
async function send(key: string, text: string): Promise<void> {
  const sent = await api("POST", `/threads/${key}/turns`, { kind: "message", parts: [{ type: "text", text }] });
  expect(sent.status).toBe(202);
}

/** A usage report that puts the next model Step over the limit of the Agent. */
const over = reply.usage({ input: CONTEXT.window - CONTEXT.reserveTokens + 1, output: 1 });
/** About 600 tokens of text, thus the latest Turn alone covers `keepRecentTokens`. */
const big = (label: string) => `${label} ${"x".repeat(CONTEXT.keepRecentTokens * 4)}`;

/**
 * Stops the Thread Durable Object of the scenario while its Turn runs, as a stopped dev server or a reset by
 * Cloudflare does. An abort ends the code in flight and its storage access at once. The name is the one that
 * the Framework gives a Thread: `{scope}/thread/{threadId}`.
 */
async function interrupt(): Promise<void> {
  const { generation } = await sampleData(env.PLAYGROUND_DATA, SCOPE, COMPACTION).read();
  const stub = env.KARMI_THREADS.getByName(`${SCOPE}/thread/${LEDGER}-${String(generation)}`);
  // The abort ends the call that made it too, thus the call rejects.
  await runInDurableObject(stub, (_instance, state) => state.abort("The dev server stopped.")).catch(() => undefined);
}

const summaryRequest = () => provider.requests.find((request) => request.system?.includes("compacting"));

beforeEach(async () => {
  await api("POST", `${PATH}/reset`);
});

describe("the state of the scenario", () => {
  it("starts with the sample ledger, the context limits of the Agent and an idle Thread", async () => {
    const now = await state();
    expect(now.ledger).toEqual({ ...STARTING_LEDGER, held: false });
    expect(now.context).toEqual(CONTEXT);
    expect(now.turn.state).toBe("idle");
  });

  it("holds the ledger now or from a number of entries, and refuses a request without a boolean", async () => {
    expect((await hold(true)).ledger).toMatchObject({ held: true, holdFrom: STARTING_LEDGER.entries.length });
    expect((await hold(false)).ledger).toMatchObject({ held: false });
    expect((await hold(true, 8)).ledger).toMatchObject({ held: false, holdFrom: 8 });
    expect((await api("POST", `${PATH}/hold`, { held: "yes" })).status).toBe(400);
    expect((await api("POST", `${PATH}/hold`, { held: true, from: -1 })).status).toBe(400);
  });
});

describe("Compaction", () => {
  it("compacts before the model Step of the next Turn once the reported usage is over the limit", async () => {
    provider.script([
      [reply.toolCall("post_entry", { text: "Window cleaning", amount: 12 }, "c1")],
      [reply.text("Posted."), over],
      "SUMMARY",
      "Continued after the Compaction.",
    ]);
    const { threadKey } = await state();
    await send(threadKey, big("Post an entry."));
    await until(threadKey, "turn.completed");
    await send(threadKey, big("What is in the ledger?"));
    const log = await until(threadKey, "turn.completed", 2);
    const second = log.filter((event) => event.turn === 2);
    expect(second).toHaveSequence([
      "turn.started",
      "step.started",
      "thread.compacted",
      "step.completed",
      "step.started",
      "turn.completed",
    ]);
    expect(second).toContainEvent({ type: "step.started", kind: "compact", trigger: "auto" });
    const kept = second.find((event) => event.type === "turn.started")?.seq ?? 0;
    expect(second).toContainEvent({
      type: "thread.compacted",
      trigger: "auto",
      summary: "SUMMARY",
      firstKeptSeq: kept,
    });
    // The log keeps each event of the first Turn, with the Tool result that the Compaction summarised.
    expect(log).toContainEvent({ type: "tool.result", name: "post_entry", isError: false });
    // The summarising call sees the dropped events. The model Step sees the summary and the kept tail.
    expect(JSON.stringify(summaryRequest()?.messages)).toContain("Window cleaning");
    const after = provider.requests.at(-1)?.messages;
    expect(JSON.stringify(after?.[0])).toContain("SUMMARY");
    expect(JSON.stringify(after?.at(-1))).toContain("What is in the ledger?");
    // The Agent continues. The check is the end of the Turn, not the words of the model.
    expect(second.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
  });

  it("compacts an idle Thread on request, with the instructions of the operator", async () => {
    provider.script(["One.", "Two.", "SUMMARY"]);
    const { threadKey } = await state();
    await send(threadKey, big("One"));
    await until(threadKey, "turn.completed");
    await send(threadKey, big("Two"));
    await until(threadKey, "turn.completed", 2);
    const compacted = await api("POST", `/threads/${threadKey}/compact`, { instructions: "Keep each entry id." });
    expect(compacted.status).toBe(204);
    const log = await until(threadKey, "thread.compacted");
    expect(log).toContainEvent({ type: "thread.compacted", trigger: "manual", summary: "SUMMARY" });
    expect(JSON.stringify(summaryRequest()?.messages)).toContain("Keep each entry id.");
  });

  it("refuses a Compaction while a Turn runs", async () => {
    provider.script([[reply.toolCall("read_ledger", {}, "c1")], "Done."]);
    await hold(true);
    const { threadKey } = await state();
    await send(threadKey, "Read the ledger.");
    await until(threadKey, "tool.call");
    const busy = await api("POST", `/threads/${threadKey}/compact`, {});
    expect(busy.status).toBe(409);
    await hold(false);
    await until(threadKey, "turn.completed");
  });
});

describe("recovery after an interruption", () => {
  it("runs a read-only call again and keeps the result of the call that finished", async () => {
    provider.script(({ index }) => {
      if (index === 0) return [reply.toolCall("post_entry", { text: "Window cleaning", amount: 12 }, "c1")];
      // The ledger is held from the second call on, thus the read waits until the operator releases it.
      if (index === 1) return hold(true).then(() => [reply.toolCall("read_ledger", {}, "c2")]);
      return "The ledger has the new entry.";
    });
    const { threadKey } = await state();
    await send(threadKey, "Post an entry, then read the ledger.");
    await until(threadKey, "tool.call", 2);
    await interrupt();
    await hold(false);
    await clock.advance("1m");
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({ type: "turn.resumed", reason: "recovered" });
    expect(log).toContainEvent({ type: "step.started", kind: "tool", attempt: 2 });
    // The finished call is not run again. The read-only call runs again and reports a result.
    expect(log.filter((event) => event.type === "tool.result" && event.name === "post_entry")).toHaveLength(1);
    expect(log).toContainEvent({ type: "tool.result", name: "read_ledger", isError: false });
    expect(log.filter((event) => event.type === "tool.result" && "interrupted" in event)).toHaveLength(0);
    expect((await state()).ledger.entries).toHaveLength(STARTING_LEDGER.entries.length + 1);
  });

  it("gives an interrupted call that is not safe to repeat an error result, and the entry stays once", async () => {
    provider.script(({ index }) => {
      if (index === 0)
        return hold(true).then(() => [reply.toolCall("post_entry", { text: "Repairs", amount: 40 }, "c1")]);
      return "The call was interrupted. The ledger has the entry one time.";
    });
    const { threadKey } = await state();
    await send(threadKey, "Post an entry.");
    // The Tool writes the entry, then waits. The interruption comes after the write and before the result.
    await expect
      .poll(async () => (await state()).ledger.entries.length, { timeout: 10_000 })
      .toBe(STARTING_LEDGER.entries.length + 1);
    await interrupt();
    await hold(false);
    await clock.advance("1m");
    const log = await until(threadKey, "turn.completed");
    expect(log).toContainEvent({ type: "turn.resumed", reason: "recovered" });
    expect(log).toContainEvent({ type: "tool.result", name: "post_entry", isError: true, interrupted: { attempt: 2 } });
    const result = log.find((event) => event.type === "tool.result");
    expect(JSON.stringify(result)).toContain("interrupted");
    // The model gets the error result and decides what to do.
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("interrupted");
    expect((await state()).ledger.entries).toHaveLength(STARTING_LEDGER.entries.length + 1);
  });
});

describe("the reset of the scenario", () => {
  it("cancels the Turn that waits for the ledger and restores the sample data", async () => {
    provider.script([[reply.toolCall("read_ledger", {}, "c1")], "Done."]);
    await hold(true);
    const { threadKey } = await state();
    await send(threadKey, "Read the ledger.");
    await until(threadKey, "tool.call");
    const after = stateSchema.parse(await (await api("POST", `${PATH}/reset`)).json());
    expect(after.threadKey).not.toBe(threadKey);
    expect(after.ledger).toEqual({ ...STARTING_LEDGER, held: false });
    expect(after.turn.state).toBe("idle");
  });

  it("does not change the refund scenario", async () => {
    const refund: unknown = await (await api("GET", "/api/scenarios/refund")).json();
    await hold(true);
    await api("POST", `${PATH}/reset`);
    expect(await (await api("GET", "/api/scenarios/refund")).json()).toEqual(refund);
  });
});
