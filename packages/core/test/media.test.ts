import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { karmi, clock, provider, scope, recovery } from "./worker";
import { reply } from "../src/testing/index";

const pdf = "%PDF-1.7\n";
const message = { kind: "message" as const, parts: [{ type: "text" as const, text: "Hello" }] };

describe("Thread media", () => {
  it("sniffs bytes, measures streamed uploads and reopens their owning Thread", async () => {
    const thread = scope.thread({ agent: "concierge", threadId: "media-upload" });
    const ref = await thread.uploads.put(new Response(pdf).body!, { mimeType: "image/png", name: "report.pdf" });
    expect(ref).toMatchObject({ mimeType: "application/pdf", bytes: 9, name: "report.pdf" });
    expect(ref.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ref.key).toBe(`test/media/media-upload/${ref.id}`);
    expect(await (await env.KARMI_MEDIA.get(ref.key))?.text()).toBe(pdf);
    expect(await scope.thread(thread.key).status()).toMatchObject({ state: "idle" });
  });

  it("enforces Scope limits after sniffing, and rejects overflow without leaving an object", async () => {
    const limited = karmi.scope("media-limits");
    await limited.config.set({ media: { maxBytes: 10, allowedTypes: ["application/pdf"] } });
    const thread = limited.thread({ agent: "concierge", threadId: "upload" });
    await expect(thread.uploads.put(pdf, { mimeType: "image/png" })).resolves.toMatchObject({
      mimeType: "application/pdf",
    });
    await expect(thread.uploads.put("plain", { mimeType: "image/png" })).rejects.toMatchObject({
      code: "media.typeDenied",
    });
    await expect(thread.uploads.put(pdf + "extra")).rejects.toMatchObject({ code: "media.tooLarge" });
    expect((await env.KARMI_MEDIA.list({ prefix: "media-limits/" })).objects).toHaveLength(1);
  });

  it("aborts multipart uploads on overflow and cancels the input stream", async () => {
    const limited = karmi.scope("media-multipart");
    await limited.config.set({ media: { maxBytes: 5 * 1024 * 1024 } });
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(reads++ === 0 ? 5 * 1024 * 1024 : 1));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      limited.thread({ agent: "concierge", threadId: "overflow" }).uploads.put(stream),
    ).rejects.toMatchObject({ code: "media.tooLarge" });
    expect(cancelled).toBe(true);
    expect((await env.KARMI_MEDIA.list({ prefix: "media-multipart/" })).objects).toEqual([]);
  });

  it("keeps media in a Tool result as refs and removes media, spill and Thread state in scheduler batches", async () => {
    const thread = scope.thread({ agent: "recovery", threadId: "media-delete" });
    recovery.execute = async (_, ctx) => {
      const ref = await ctx.media.put(pdf);
      return JSON.stringify(ref);
    };
    provider.script([[reply.toolCall("recover_read", { id: "a" }, "call")], "done"]);
    const events = await thread.send(message);
    const output = events.find((event) => event.type === "tool.result");
    expect(output).toMatchObject({ isError: false });
    const ref = await thread.uploads.put(pdf);
    for (let i = 0; i < 101; i++) await env.KARMI_MEDIA.put(`test/threads/media-delete/tool-output/${i}`, "spill");
    await env.KARMI_MEDIA.put("test/media/other-thread/keep", "keep");
    await thread.delete();
    await expect(thread.status()).rejects.toMatchObject({ code: "thread.deleted" });
    await expect(thread.uploads.put(pdf)).rejects.toMatchObject({ code: "thread.deleted" });
    await clock.advance(0);
    expect(await env.KARMI_MEDIA.get(ref.key)).toBeNull();
    expect((await env.KARMI_MEDIA.list({ prefix: "test/threads/media-delete/" })).objects).toEqual([]);
    expect((await env.KARMI_MEDIA.list({ prefix: "test/media/media-delete/" })).objects).toEqual([]);
    expect(await env.KARMI_MEDIA.get("test/media/other-thread/keep")).not.toBeNull();
    await thread.delete();
  });
});

it("describes non-PDF file Parts even when their MIME is an image", async () => {
  const thread = scope.thread({ agent: "concierge", threadId: "media-file" });
  const ref = await thread.uploads.put("image bytes", { mimeType: "image/png", name: "photo.png" });
  provider.script(["OK"]);
  await thread.send({ kind: "message", parts: [{ type: "file", media: ref }] });
  expect(provider.requests[0]?.messages[0]).toMatchObject({
    content: [{ type: "text", text: "[file: photo.png, image/png, 11 bytes — not viewable]" }],
  });
});

it("returns native Tool image blocks and ctx.media.put results as media refs", async () => {
  recovery.execute = async (_, ctx) => ({
    content: [
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "media", media: await ctx.media.put(pdf, { name: "report.pdf" }) },
    ],
  });
  const thread = scope.thread({ agent: "recovery", threadId: "media-tool-images" });
  provider.script([[reply.toolCall("recover_read", { id: "a" })], "done"]);
  const events = await thread.send(message);
  const output = events.find((event) => event.type === "tool.result");
  expect(output).toMatchObject({
    content: [
      { type: "media", media: { mimeType: "image/png", bytes: 5 } },
      { type: "media", media: { mimeType: "application/pdf", bytes: 9, name: "report.pdf" } },
    ],
  });
  expect(JSON.stringify(events)).not.toContain("aGVsbG8=");
});

it("presigns a GET with an explicit expiry and refuses invalid TTLs", async () => {
  const ref = await scope.thread({ agent: "concierge", threadId: "media-url" }).uploads.put(pdf);
  const url = new URL(await karmi.media.url(ref, { ttl: 90 }));
  expect(url.hostname).toBe("test-account.r2.cloudflarestorage.com");
  expect(url.pathname).toBe(`/karmi-test-media/${ref.key}`);
  expect(url.searchParams.get("X-Amz-Expires")).toBe("90");
  expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  await expect(karmi.media.url(ref, { ttl: 604801 })).rejects.toMatchObject({ code: "media.urlInvalid" });
  await expect(karmi.media.url(ref, { ttl: 0 })).rejects.toMatchObject({ code: "media.urlInvalid" });
});

it("refuses reads across Scopes, across Threads and of forged MIME metadata", async () => {
  const origin = karmi.scope("media-origin").thread({ agent: "concierge", threadId: "owner" });
  const ref = await origin.uploads.put(pdf);
  const sibling = await scope.thread({ agent: "concierge", threadId: "media-scope-owner" }).uploads.put(pdf);
  const thread = scope.thread({ agent: "concierge", threadId: "media-scope-reader" });
  const local = await thread.uploads.put(pdf);
  provider.script(async ({ options }) => {
    expect(await options.media?.get(ref)).toBeUndefined();
    expect(await options.media?.get(sibling)).toBeUndefined();
    expect(await options.media?.get(local)).toBeDefined();
    expect(await options.media?.get({ ...local, mimeType: "image/png" })).toBeUndefined();
    return "OK";
  });
  const events = await thread.send(message);
  expect(events.at(-1)?.type).toBe("turn.completed");
});

it("deletes an active Thread and prevents queued work and late writes from reviving it", async () => {
  let entered = false;
  let released = false;
  provider.script(async ({ options }) => {
    entered = true;
    while (!released) await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(options.media?.put(pdf)).rejects.toBeDefined();
    return "late";
  });
  const thread = karmi.scope("test").thread({ agent: "concierge", threadId: "media-active-delete" });
  await thread.send(message);
  await expect.poll(() => entered).toBe(true);
  await thread.send(message);
  await thread.delete();
  released = true;
  await expect
    .poll(async () => {
      await clock.advance(1000);
      return (await karmi.scope("test").threads.list({ agent: "concierge" })).some((item) => item.key === thread.key);
    })
    .toBe(false);
  expect((await env.KARMI_MEDIA.list({ prefix: "test/media/media-active-delete/" })).objects).toEqual([]);
  await expect(thread.send(message)).rejects.toMatchObject({ code: "thread.deleted" });
});

it("does not recreate spill after a deleted Thread’s cancelled Tool eventually returns", async () => {
  let entered = false;
  let release = false;
  let returned = false;
  recovery.execute = async () => {
    entered = true;
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    returned = true;
    return "late output ".repeat(10000);
  };
  provider.script([[reply.toolCall("recover_read", { id: "a" })]]);
  const thread = karmi.scope("test").thread({ agent: "recovery", threadId: "media-late-spill" });
  await thread.send(message);
  await expect.poll(() => entered).toBe(true);
  await thread.delete();
  await expect
    .poll(async () => {
      await clock.advance(1000);
      return (await karmi.scope("test").threads.list({ agent: "recovery" })).some((item) => item.key === thread.key);
    })
    .toBe(false);
  release = true;
  await expect.poll(() => returned).toBe(true);
  expect((await env.KARMI_MEDIA.list({ prefix: "test/threads/media-late-spill/" })).objects).toEqual([]);
});

it("discards an upload this Thread minted and leaves a ref from another Thread alone", async () => {
  const thread = scope.thread({ agent: "concierge", threadId: "media-discard" });
  const ref = await thread.uploads.put(pdf, { name: "report.pdf" });
  provider.script(["OK"]);
  const events = await thread.send({ kind: "message", parts: [{ type: "file", media: ref }] });
  // A Fork holds its own copy of the ref, so its delete removes that copy and leaves the original alone.
  const fork = await thread.fork(events.at(-1)!.seq, { threadId: "media-discard-fork" });
  await fork.uploads.delete(ref);
  expect(await env.KARMI_MEDIA.get(ref.key)).not.toBeNull();
  expect(await env.KARMI_MEDIA.get(`test/media/media-discard-fork/${ref.id}`)).toBeNull();
  await thread.uploads.delete(ref);
  expect(await env.KARMI_MEDIA.get(ref.key)).toBeNull();
  // Deleting what is already gone is a no-op, and a ref whose id karmi never minted is refused.
  await thread.uploads.delete(ref);
  await expect(thread.uploads.delete({ ...ref, id: "not-an-id/" })).rejects.toMatchObject({
    code: "media.id.invalid",
  });
});

describe("thread.fork() media", () => {
  it("copies the file and spilled output a Fork refers to, so both outlive the original Thread", async () => {
    recovery.execute = async () => "spilled output ".repeat(10000);
    const thread = scope.thread({ agent: "recovery", threadId: "media-fork-original" });
    const upload = await thread.uploads.put(pdf, { name: "report.pdf" });
    provider.script([[reply.toolCall("recover_read", { id: "a" })], "done"]);
    const events = await thread.send({ kind: "message", parts: [{ type: "file", media: upload }] });
    const fork = await thread.fork(events.at(-1)!.seq, { threadId: "media-fork-copy" });
    await thread.delete();
    await expect
      .poll(async () => {
        await clock.advance(1000);
        const listed = await Promise.all(
          ["test/media/media-fork-original/", "test/threads/media-fork-original/"].map((prefix) =>
            env.KARMI_MEDIA.list({ prefix }),
          ),
        );
        return listed.flatMap((list) => list.objects).length;
      })
      .toBe(0);

    const forked = await fork.events();
    const input = forked.find((event) => event.type === "turn.started");
    const result = forked.find((event) => event.type === "tool.result");
    const file = input?.input.kind === "message" ? input.input.parts[0] : undefined;
    if (file?.type !== "file" || !result?.output) throw new Error("The Fork lost its refs.");
    expect(file.media.key).toBe(`test/media/media-fork-copy/${upload.id}`);
    expect(result.output.key).toMatch(/^test\/threads\/media-fork-copy\/tool-output\/\d+$/);
    const reads: (ArrayBuffer | undefined)[] = [];
    provider.script(async ({ options }) => {
      reads.push(await options.media?.get(file.media), await options.media?.get(result.output!));
      return "OK";
    });
    await fork.send(message);
    await expect.poll(() => reads.length).toBe(2);
    expect(reads.map((bytes) => bytes && new TextDecoder().decode(bytes))).toEqual([
      pdf,
      "spilled output ".repeat(10000),
    ]);
  });

  it("fails the whole fork when one copy fails and leaves no Thread and no objects behind", async () => {
    const thread = scope.thread({ agent: "concierge", threadId: "media-fork-failing" });
    const first = await thread.uploads.put(pdf);
    const second = await thread.uploads.put(pdf);
    provider.script(["OK"]);
    const events = await thread.send({
      kind: "message",
      parts: [
        { type: "file", media: first },
        { type: "file", media: second },
      ],
    });
    const bucket: R2Bucket = Object.getPrototypeOf(env.KARMI_MEDIA);
    const put = bucket.put;
    const failing = vi.spyOn(bucket, "put").mockImplementation(function (this: R2Bucket, key, ...rest) {
      if (key === `test/media/media-fork-failed/${second.id}`) return Promise.reject(new Error("R2 is down."));
      return put.call(this, key, ...rest);
    });
    try {
      await expect(thread.fork(events.at(-1)!.seq, { threadId: "media-fork-failed" })).rejects.toThrow("R2 is down.");
    } finally {
      failing.mockRestore();
    }
    await expect
      .poll(async () => {
        await clock.advance(1000);
        const listed = await Promise.all(
          ["test/media/media-fork-failed/", "test/threads/media-fork-failed/"].map((prefix) =>
            env.KARMI_MEDIA.list({ prefix }),
          ),
        );
        return listed.flatMap((list) => list.objects).length;
      })
      .toBe(0);
    // A handle opened from a key never creates the Thread, so it can observe that none is left.
    const failed = scope.thread(scope.thread({ agent: "concierge", threadId: "media-fork-failed" }).key);
    await expect(failed.status()).rejects.toMatchObject({ code: "thread.notFound" });
    expect(await env.KARMI_MEDIA.get(second.key)).not.toBeNull();
  });

  it("skips an object already missing in the original Thread", async () => {
    const thread = scope.thread({ agent: "concierge", threadId: "media-fork-missing" });
    const ref = await thread.uploads.put(pdf);
    provider.script(["OK"]);
    const events = await thread.send({ kind: "message", parts: [{ type: "file", media: ref }] });
    await env.KARMI_MEDIA.delete(ref.key);
    const fork = await thread.fork(events.at(-1)!.seq, { threadId: "media-fork-missing-copy" });
    expect((await fork.events()).length).toBe(events.length);
    expect((await env.KARMI_MEDIA.list({ prefix: "test/media/media-fork-missing-copy/" })).objects).toEqual([]);
  });
});
