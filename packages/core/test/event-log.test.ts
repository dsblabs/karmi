import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { openThreadDatabase } from "../src/db/thread/database";
import { EventLog } from "../src/event-log";
import type { ThreadEventData } from "../src/thread-events";

// Each test opens the SQL of a fresh Thread Durable Object. The constructor of that object has run the
// migrations, and no Turn runs.
async function withLog(name: string, run: (open: () => EventLog) => void): Promise<void> {
  await runInDurableObject(env.KARMI_THREADS.getByName(`event-log-${name}`), (_, state) => {
    run(() => new EventLog(openThreadDatabase(state.storage.sql)));
  });
}

const delta: ThreadEventData = { type: "message.delta", index: 0, kind: "text", text: "Hi" };
const call = (id: string): ThreadEventData => ({ type: "tool.call", id, name: "lookup", input: {} });
const result = (id: string): ThreadEventData => ({
  type: "tool.result",
  id,
  name: "lookup",
  content: [],
  isError: false,
});

describe("Thread event log", () => {
  it("numbers events from 1 and reads its head again from the table", async () => {
    await withLog("head", (open) => {
      const log = open();
      expect(log.head).toBe(0);
      expect(log.append(1, delta, undefined, 10)).toEqual({ ...delta, seq: 1, turn: 1, at: 10 });
      expect(log.append(1, delta, { chat: "c1" }, 11)).toMatchObject({ seq: 2, channelRef: { chat: "c1" } });
      expect(log.head).toBe(2);
      expect(open().head).toBe(2);
      expect(open().append(2, delta, undefined, 12).seq).toBe(3);
    });
  });

  it("seeds and reads more rows than one SQL statement can bind", async () => {
    await withLog("bound-source", (open) => {
      const log = open();
      for (let n = 0; n < 250; n++) log.append(1, delta, undefined, n);
      const rows = log.copyThrough(250);
      const seqs = rows.map((row) => row.seq);
      expect(log.usageRecords(seqs)).toEqual([]);
      log.clear();
      log.seed(rows);
      expect(log.head).toBe(250);
      expect(log.copyThrough(250)).toEqual(rows);
    });
  });

  it("reads a range without the event types that the granularity omits", async () => {
    await withLog("read", (open) => {
      const log = open();
      log.append(1, delta, undefined, 1);
      log.append(1, call("a"), undefined, 2);
      log.append(1, delta, undefined, 3);
      log.append(1, result("a"), undefined, 4);
      expect(log.read(0, "delta", 10).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(log.read(0, "part", 10).map((event) => event.seq)).toEqual([2, 4]);
      expect(log.read(1, "delta", 10, 3).map((event) => event.seq)).toEqual([2, 3]);
      expect(log.read(0, "delta", 1).map((event) => event.seq)).toEqual([1]);
      expect(log.turnEvents(1).map((logged) => logged.seq)).toEqual([2, 4]);
      expect(log.firstSeq(1)).toBe(1);
      expect(log.firstSeq(2)).toBeUndefined();
    });
  });

  it("finds the result of a Tool call by its id, after the call and in its Turn", async () => {
    await withLog("tool-result", (open) => {
      const log = open();
      log.append(1, call("a"), undefined, 1);
      log.append(1, result("a"), undefined, 2);
      // A later Turn can use the same model tool-call id again.
      const second = log.append(2, call("a"), undefined, 3);
      const other = log.append(2, call("b"), undefined, 4);
      log.append(2, result("b"), undefined, 5);
      if (second.type !== "tool.call" || other.type !== "tool.call") throw new Error("Expected tool.call events.");
      expect(log.toolResult(second)).toBeUndefined();
      expect(log.toolResult(other)?.seq).toBe(5);
      log.append(2, result("a"), undefined, 6);
      expect(log.toolResult(second)?.seq).toBe(6);
    });
  });

  it("finds a started Job by its id", async () => {
    await withLog("job", (open) => {
      const log = open();
      log.append(1, { type: "job.started", id: "a", jobId: "job-1" }, undefined, 1);
      expect(log.hasStartedJob("job-1")).toBe(true);
      expect(log.hasStartedJob("job-2")).toBe(false);
    });
  });

  it("returns only the Load points from the first kept seq of the last Compaction", async () => {
    await withLog("load-points", (open) => {
      const log = open();
      expect(log.lastCompaction()).toEqual({ seq: 0, firstKeptSeq: 1 });
      log.append(1, { type: "tools.loaded", names: ["dropped"] }, undefined, 1);
      log.append(1, { type: "tools.loaded", names: ["kept"] }, undefined, 2);
      const compacted = log.append(
        2,
        {
          type: "thread.compacted",
          trigger: "manual",
          strategy: "harness",
          firstKeptSeq: 2,
          tokensBefore: 10,
          tokensAfter: 5,
          summary: "",
          provider: "fake",
          model: "fake/model",
          attachments: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        undefined,
        3,
      );
      expect(log.lastCompaction()).toEqual({ seq: compacted.seq, firstKeptSeq: 2 });
      expect(log.loadPoints().map((event) => event.names)).toEqual([["kept"]]);
    });
  });

  it("counts Provider Tool calls for a Turn or the Thread and stops at the maximum", async () => {
    await withLog("provider-tools", (open) => {
      const log = open();
      const called = {
        type: "server_tool.called",
        id: "s",
        name: "web_search",
        input: {},
        raw: {},
        summary: "",
      } as const;
      log.append(1, called, undefined, 1);
      log.append(2, called, undefined, 2);
      log.append(2, called, undefined, 3);
      expect(log.providerToolCalls(10)).toBe(3);
      expect(log.providerToolCalls(10, 2)).toBe(2);
      expect(log.providerToolCalls(2)).toBe(2);
    });
  });

  it("seeds a Fork with the copied rows and clears to an empty log", async () => {
    await withLog("seed-source", (open) => {
      const source = open();
      source.append(1, call("a"), undefined, 1);
      source.append(1, result("a"), undefined, 2);
      source.append(2, delta, undefined, 3);
      const rows = source.copyThrough(2);
      expect(rows.map((row) => row.seq)).toEqual([1, 2]);
      source.clear();
      expect(source.head).toBe(0);
      expect(source.read(0, "delta", 10)).toEqual([]);
      source.seed(rows);
      expect(source.head).toBe(2);
      expect(open().at(2)?.type).toBe("tool.result");
      expect(source.append(2, delta, undefined, 4).seq).toBe(3);
    });
  });
});
