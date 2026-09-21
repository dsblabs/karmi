import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { openThreadDatabase } from "../src/db/thread/database";
import { UsageOutbox } from "../src/usage";

it("gives the waiting records in order, one batch at a time, and removes the settled ones", async () => {
  await runInDurableObject(env.KARMI_THREADS.getByName("usage-outbox"), (_, state) => {
    const outbox = new UsageOutbox(openThreadDatabase(state.storage.sql));
    expect(outbox.batch(2)).toEqual({ seqs: [], more: false });
    for (const seq of [9, 4, 7]) outbox.enqueue(seq);
    expect(outbox.batch(2)).toEqual({ seqs: [4, 7], more: true });
    outbox.settle(7);
    expect(outbox.batch(2)).toEqual({ seqs: [9], more: false });
    outbox.clear();
    expect(outbox.batch(2)).toEqual({ seqs: [], more: false });
  });
});
