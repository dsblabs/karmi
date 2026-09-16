import * as z from "zod/mini";
import { KarmiError } from "./errors";
import type { EmbeddingIndex } from "./vector-store";

const indexSchema = z.object({
  success: z.literal(true),
  result: z.object({ config: z.object({ dimensions: z.int(), metric: z.string() }) }),
});
const metadataSchema = z.object({
  success: z.literal(true),
  result: z.object({ metadataIndexes: z.array(z.object({ propertyName: z.string(), indexType: z.string() })) }),
});
/** Checks a Vectorize index's dimensions, metric and required metadata indexes through the management API. */
export async function checkVectorizeIndex(
  indexName: string,
  expected: Pick<EmbeddingIndex, "dims" | "metric">,
  credentials: { accountId: string; apiToken: string },
  transport: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`;
  const headers = { Authorization: `Bearer ${credentials.apiToken}` };
  const responses = await Promise.all([
    transport(url, { headers }),
    transport(`${url}/metadata_index/list`, { headers }),
  ]);
  const [index, metadata] = responses;
  if (!index?.ok || !metadata?.ok)
    throw new KarmiError(
      "knowledge.invalid",
      "Could not inspect the Vectorize index; check account, index and API permissions.",
    );
  const { config } = z.parse(indexSchema, await index.json()).result;
  if (config.dimensions !== expected.dims || config.metric !== expected.metric)
    throw new KarmiError(
      "knowledge.indexConflict",
      `Vectorize ${indexName} uses ${config.dimensions}/${config.metric}; Knowledge requires ${expected.dims}/${expected.metric}.`,
    );
  const fields = z.parse(metadataSchema, await metadata.json()).result.metadataIndexes;
  for (const property of ["knowledge", "doc"])
    if (!fields.some((field) => field.propertyName === property && field.indexType === "string"))
      throw new KarmiError(
        "knowledge.invalid",
        `Vectorize ${indexName} needs a string metadata index on ${property} before ingest.`,
      );
}
