import { defineAgent, type KnowledgeDocument, type Passage } from "@karmi/core";
import { z } from "zod";
import { decodeSample } from "./sample-data";

/** The id of the Knowledge scenario. */
export const KNOWLEDGE = "knowledge";
/** The id of the Agent of the scenario. */
export const LIBRARIAN = "librarian";

/** The corpora of the scenario. The Agent searches the handbook with a Tool and gets the notices in its Prompt. */
export const CORPORA = [
  { name: "handbook", mode: "search" },
  { name: "notices", mode: "inline" },
] as const satisfies readonly { name: string; mode: "search" | "inline" }[];

/** The name of one corpus of the scenario. */
export type CorpusName = (typeof CORPORA)[number]["name"];

/** The prompts that the scenario suggests. The operator can edit each one. */
export const LIBRARIAN_PROMPTS = [
  { label: "Search", text: "How many days does a customer have to return a product? Search the handbook." },
  { label: "Inline", text: "Is the shop open on Sunday?" },
  { label: "Bulk", text: "Which shelf holds bean lot 12? Search the handbook." },
];

/** The schema of one document that the scenario keeps: what the operator ingested, with its title. */
const documentSchema = z.object({ id: z.string().min(1), title: z.string(), text: z.string() });

/** One document of the scenario. */
export type SampleDocument = z.infer<typeof documentSchema>;

/** The schema of a Passage of the Framework, as the Retriever returns it. The type check keeps its keys equal to `Passage`. */
const passageSchema = z.object({
  source: z.optional(z.enum(["fts", "vector", "hybrid"])),
  docId: z.string(),
  text: z.string(),
  score: z.number(),
  seq: z.optional(z.number()),
  metadata: z.optional(z.record(z.string(), z.unknown())),
} satisfies Record<keyof Passage, z.ZodType>);

/** The schema of the sample data of the scenario. */
const knowledgeDataSchema = z.object({
  /** The documents of each corpus, by corpus name. */
  documents: z.record(z.string(), z.array(documentSchema)),
  /** How many bulk ingests the operator started since the last reset. The id of the last Job holds the count. */
  bulk: z.number().int().nonnegative(),
  /** The last search of the operator and the Passages that the Retriever returned. */
  search: z.optional(z.object({ query: z.string(), passages: z.array(passageSchema) })),
});

/** The sample data of the scenario. */
export type KnowledgeData = z.infer<typeof knowledgeDataSchema>;

/** The documents that the scenario starts with and that a reset restores, by corpus name. */
export const STARTING_DOCUMENTS: Record<string, SampleDocument[]> = {
  handbook: [
    {
      id: "refunds",
      title: "Refund policy",
      text: "A customer can return a product within 30 days of the purchase. The shop refunds the price to the original payment method.",
    },
    {
      id: "beans",
      title: "Bean storage",
      text: "Store each bean lot in a sealed container on the shelf that its label names. Roasted beans keep for four weeks.",
    },
    {
      id: "allergens",
      title: "Allergens",
      text: "Each drink with oat, almond or soy milk gets an allergen label. The barista confirms the milk before the pour.",
    },
  ],
  notices: [
    {
      id: "hours",
      title: "Opening hours",
      text: "The shop is open from Monday to Saturday, from 8:00 to 18:00. The shop is closed on Sunday.",
    },
    {
      id: "service",
      title: "Roaster service",
      text: "The shop is closed on the first Monday of October for the service of the roaster.",
    },
  ],
};

/** The number of documents of one bulk ingest. It is above the 32 documents that a small ingest permits. */
export const BULK_DOCUMENTS = 40;

/** The documents of a bulk ingest: one page of the handbook for each bean lot. Each run ingests the same ones. */
export const bulkDocuments = (): SampleDocument[] =>
  Array.from({ length: BULK_DOCUMENTS }, (_, index) => {
    const lot = String(index + 1);
    return {
      id: `lot-${lot}`,
      title: `Bean lot ${lot}`,
      text: `Handbook page for bean lot ${lot}. Bean lot ${lot} is on shelf ${lot} of the cold room.`,
    };
  });

/** Decodes the stored sample data. Data that is absent or not valid gives the starting documents. */
export const decodeKnowledgeData = (data: string | undefined): KnowledgeData =>
  decodeSample(knowledgeDataSchema, { documents: STARTING_DOCUMENTS, bulk: 0 }, data);

/** The document as the Framework ingests it. The title goes in the metadata, which each Passage carries. */
export const toKnowledgeDocument = ({ id, title, text }: SampleDocument): KnowledgeDocument => ({
  id,
  text,
  metadata: { title },
});

/**
 * Defines the Agent for the model that setup selected. The `knowledge` block gives it the read-only Tool
 * `search_handbook` and puts the full text of the notices in its Prompt at the start of each Turn.
 */
export const librarianAgent = (model: string) =>
  defineAgent({
    agentId: LIBRARIAN,
    name: "Coffee shop librarian",
    instructions: [
      {
        text: "You keep the handbook of a small coffee shop. When the customer asks about the handbook, a rule or a bean lot, call search_handbook with the two or three most specific words of the question, then answer in one sentence and name the id of the document that you used. When the search finds nothing, say that the handbook has nothing about that. The notices of the shop are in the Knowledge section of these instructions: answer a question about opening hours or a closure from that section, without a Tool call. When the section has no notice about it, say so.",
      },
    ],
    model: { id: model },
    knowledge: [...CORPORA],
  });
