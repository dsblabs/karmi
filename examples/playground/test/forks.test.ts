import type { ThreadEvent } from "@karmi/core";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { api, events } from "./client";
import { clock, karmi, provider } from "./worker";
import { TOKEN } from "./worker-options";

const mediaSchema = z.object({
  id: z.string(),
  key: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
  name: z.string().optional(),
});
const threadViewSchema = z.object({
  deleted: z.boolean(),
  events: z.array(z.object({ seq: z.number(), type: z.string() }).loose()),
  media: z.array(mediaSchema),
  threadKey: z.string(),
});
const forksViewSchema = z.object({
  fork: threadViewSchema.nullable(),
  original: threadViewSchema,
  positions: z.array(z.object({ label: z.string(), seq: z.number() })),
  threadKey: z.string(),
});
type ForkThreadView = z.output<typeof threadViewSchema>;
type ForksView = z.output<typeof forksViewSchema>;

function decodeView(value: unknown): ForksView {
  return forksViewSchema.parse(value);
}

function threadKeyOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("threadKey" in value) || typeof value.threadKey !== "string")
    throw new Error("Not a scenario state.");
  return value.threadKey;
}

function firstMedia(thread: ForkThreadView): z.output<typeof mediaSchema> {
  const media = thread.media[0];
  if (!media) throw new Error("The Thread has no media.");
  return media;
}

function forkOf(view: ForksView): ForkThreadView {
  if (!view.fork) throw new Error("The scenario has no Fork.");
  return view.fork;
}

async function state(): Promise<ForksView> {
  return decodeView(await (await api(TOKEN, "GET", "/api/scenarios/forks")).json());
}

async function until(key: string, type: ThreadEvent["type"]): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect
    .poll(async () => (log = await events(key)).some((event) => event.type === type), { timeout: 10_000 })
    .toBe(true);
  return log;
}

async function upload(bytes = "sample media bytes"): Promise<ForksView> {
  const { threadKey } = await state();
  const form = new FormData();
  form.append("text", "Tell me what file I uploaded.");
  form.append("file", new File([bytes], "sample.txt", { type: "text/plain" }));
  const response = await SELF.fetch(`https://playground.test/threads/${threadKey}/turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  expect(response.status).toBe(202);
  await until(threadKey, "turn.completed");
  return state();
}

async function fork(view: ForksView): Promise<ForksView> {
  const position = view.positions.at(-1);
  if (!position) throw new Error("The scenario has no supported Fork position.");
  const response = await api(TOKEN, "POST", "/api/scenarios/forks/fork", { seq: position.seq });
  expect(response.status).toBe(200);
  return decodeView(await response.json());
}

async function download(
  thread: ForkThreadView,
  media: z.output<typeof mediaSchema>,
  token: string | null = TOKEN,
): Promise<Response> {
  return api(token, "GET", `/api/scenarios/forks/threads/${thread.threadKey}/media/${media.id}`);
}

beforeEach(async () => {
  provider.script(["I received the sample file."]);
  await api(TOKEN, "POST", "/api/scenarios/forks/reset");
});

describe("the media and Fork scenario", () => {
  it("uploads and downloads the stored bytes through authenticated public routes", async () => {
    const view = await upload();
    expect(view.positions).toEqual([{ seq: expect.any(Number), label: "After Turn 1" }]);
    expect(view.original.media).toMatchObject([{ name: "sample.txt", mimeType: "text/plain", bytes: 18 }]);

    const media = firstMedia(view.original);
    const response = await download(view.original, media);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain('filename="sample.txt"');
    expect(await response.text()).toBe("sample media bytes");
    expect((await download(view.original, { ...media, id: "unknown" })).status).toBe(404);

    const earlyDelete = await api(TOKEN, "POST", "/api/scenarios/forks/original/delete");
    expect(earlyDelete.status).toBe(409);
    expect(await earlyDelete.json()).toMatchObject({
      error: { code: "playground.forkMissing", message: expect.stringContaining("Fork") },
    });

    const unsupported = await api(TOKEN, "POST", "/api/scenarios/forks/fork", { seq: 1 });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "playground.forkPosition", message: expect.stringContaining("completed Turn") },
    });
  });

  it("keeps the selected Fork and its media usable after the original is deleted", async () => {
    const original = await upload("bytes that must survive");
    const forked = await fork(original);
    const forkThread = forkOf(forked);
    expect(forkThread.events.map(({ seq, type }) => ({ seq, type }))).toEqual(
      forked.original.events.map(({ seq, type }) => ({ seq, type })),
    );
    expect(firstMedia(forkThread).key).not.toBe(firstMedia(forked.original).key);

    const deleted = await api(TOKEN, "POST", "/api/scenarios/forks/original/delete");
    expect(deleted.status).toBe(200);
    const view = decodeView(await deleted.json());
    expect(view.original.deleted).toBe(true);
    expect((await download(view.original, firstMedia(original.original))).status).toBe(404);
    const viewFork = forkOf(view);
    const copy = await download(viewFork, firstMedia(viewFork));
    expect(await copy.text()).toBe("bytes that must survive");
  });

  it("rejects unauthenticated media reads and media outside the permitted Thread or Scope", async () => {
    const view = await upload();
    const media = firstMedia(view.original);
    expect((await download(view.original, media, null)).status).toBe(401);

    const otherThread = karmi
      .scope("sample-a")
      .thread({ agent: "forks", user: "operator", threadId: `outside-${Date.now()}` });
    const other = await otherThread.uploads.put("outside Thread", { mimeType: "text/plain", name: "outside.txt" });
    expect((await api(TOKEN, "GET", `/api/scenarios/forks/threads/${otherThread.key}/media/${other.id}`)).status).toBe(
      404,
    );

    const otherScope = karmi
      .scope("sample-b")
      .thread({ agent: "forks", user: "operator", threadId: `outside-scope-${Date.now()}` });
    const scoped = await otherScope.uploads.put("outside Scope", { mimeType: "text/plain" });
    expect((await api(TOKEN, "GET", `/api/scenarios/forks/threads/${otherScope.key}/media/${scoped.id}`)).status).toBe(
      404,
    );
  });

  it("reset removes both scenario Threads while preserving another scenario and Provider credentials", async () => {
    const forked = await fork(await upload());
    const forkThread = forkOf(forked);
    const refundBefore: unknown = await (await api(TOKEN, "GET", "/api/scenarios/refund")).json();
    const originalMedia = firstMedia(forked.original);
    const forkMedia = firstMedia(forkThread);
    const credentials = karmi.scope("sample-a").credentials;
    await credentials.put("kept-by-fork-reset", "secret-value");

    const reset = await api(TOKEN, "POST", "/api/scenarios/forks/reset");
    expect(reset.status).toBe(200);
    const fresh = decodeView(await reset.json());
    expect(fresh.threadKey).not.toBe(forked.threadKey);
    expect((await api(TOKEN, "GET", `/threads/${forked.original.threadKey}`)).status).toBe(404);
    expect((await api(TOKEN, "GET", `/threads/${forkThread.threadKey}`)).status).toBe(404);
    expect((await download(forked.original, originalMedia)).status).toBe(404);
    expect((await download(forkThread, forkMedia)).status).toBe(404);
    await expect
      .poll(async () => {
        await clock.advance(1_000);
        return Promise.all([env.KARMI_MEDIA.get(originalMedia.key), env.KARMI_MEDIA.get(forkMedia.key)]);
      })
      .toEqual([null, null]);
    const refundAfter: unknown = await (await api(TOKEN, "GET", "/api/scenarios/refund")).json();
    expect(threadKeyOf(refundAfter)).toBe(threadKeyOf(refundBefore));
    expect(await credentials.describe("kept-by-fork-reset")).toMatchObject({ version: 1 });
  });
});
