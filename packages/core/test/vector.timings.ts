import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { it } from "vitest";
import { SqliteBruteForceStore } from "../src/index";

it("measures bounded SQLite vector scans in workerd", async () => {
  const stub = env.KARMI_KNOWLEDGE.getByName("vector-benchmark");
  const index = { model: "benchmark", dims: 1024, metric: "cosine" as const };
  for (const count of [1000, 10000]) {
    await runInDurableObject(stub, async (_, state) => {
      const store = new SqliteBruteForceStore(state.storage.sql, index);
      for (let start = 0; start < count; start += 100) {
        await store.upsert(
          "bench",
          Array.from({ length: 100 }, (_, i) => ({
            id: String(start + i).padStart(5, "0"),
            values: Float32Array.from({ length: 1024 }, (_, dim) => Math.sin(dim + start + i)),
            metadata: { knowledge: "bench", doc: String(start + i) },
          })),
        );
      }
    });
    for (const page of [1000, 10000]) {
      const timings: number[] = [];
      for (let repeat = 0; repeat < 6; repeat++) {
        const start = performance.now();
        await runInDurableObject(stub, async (_, state) => {
          const store = new SqliteBruteForceStore(state.storage.sql, index, page);
          await store.query("bench", new Float32Array(1024).fill(0.1), { knowledge: "bench", topK: 10 });
        });
        timings.push(performance.now() - start);
      }
      console.log(JSON.stringify({ count, dims: 1024, page, timings }));
    }
  }
}, 120000);
