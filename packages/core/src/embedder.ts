import * as z from "zod/mini";
import { KarmiError } from "./errors";
import { validateVector, type Embedder } from "./vector-store";
const responseSchema = z.object({ data: z.array(z.array(z.number())) });
/** Embeds text with Workers AI bge-m3, batching at most 100 texts per call. */
export function workersAiEmbedder(ai: Ai): Embedder {
  return {
    model: "@cf/baai/bge-m3",
    dims: 1024,
    metric: "cosine",
    async embed(texts) {
      const vectors: Float32Array[] = [];
      for (let offset = 0; offset < texts.length; offset += 100) {
        const batch = texts.slice(offset, offset + 100);
        const response = z.parse(responseSchema, await ai.run("@cf/baai/bge-m3", { text: batch }));
        if (response.data.length !== batch.length)
          throw new KarmiError("knowledge.invalid", "Embedding response did not match the input count.");
        for (const values of response.data) {
          const vector = new Float32Array(values);
          validateVector(vector, 1024);
          vectors.push(vector);
        }
      }
      return vectors;
    },
  };
}
