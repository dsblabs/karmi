import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import * as z from "zod/mini";
import type { KarmiBindings } from "./bindings";
import type { Deployment } from "./deployment";
import knowledgeMigrations from "./db/knowledge/migrations";
import { documents, ingestDocuments, ingestJobs, knowledgeHead, knowledgeSchema } from "./db/knowledge/schema";
import { errorMessage, KarmiError } from "./errors";
import { keys } from "./keys";
import {
  chunkDocument,
  knowledgeDocumentsSchema,
  knowledgeIndexSchema,
  knowledgeIngestSchema,
  KNOWLEDGE_BULK_THRESHOLD,
  type KnowledgeIngestOptions,
  type KnowledgeJob,
} from "./knowledge";
import { KnowledgeStore } from "./knowledge-store";
import { bindLogger } from "./logger";
import { fail, ok, remote, unwrap, type Outcome } from "./outcome";
import { fts5Retriever, type KnowledgeDocument, type Retriever, type RetrieverContext } from "./retriever";
import { attachRetrieverDatabase } from "./retriever-internal";
import type { ScopeConfigDurableObject } from "./scope-config-do";
import { openThread } from "./thread";

type Head = typeof knowledgeHead.$inferSelect;
type JobRow = typeof ingestJobs.$inferSelect;
const requestSchema = z.object({
  fingerprint: z.string(),
  options: knowledgeIngestSchema,
  callbackAfter: z.optional(z.number()),
});
const searchSchema = z.object({
  retriever: z.optional(z.string()),
  settings: z.optional(z.record(z.string(), z.unknown())),
});

/** Stores one corpus and resumes bulk ingest from durable document checkpoints. */
export abstract class KnowledgeDurableObject extends DurableObject<KarmiBindings> {
  abstract readonly deployment: Deployment;
  private readonly store: KnowledgeStore;
  private readonly db;

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: knowledgeSchema });
    this.store = new KnowledgeStore(this.db);
    ctx.blockConcurrencyWhile(() => migrate(this.db, knowledgeMigrations));
  }

  private config(scope: string) {
    return remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(scope));
  }

  // `tombstoned` is set by a Scope destroy walk, which runs inside the ScopeConfig Durable Object and has
  // already tombstoned the Scope, so this object neither asks it for a status nor refuses the call.
  private async enter(scope: string, name: string, tombstoned = false): Promise<Head | undefined> {
    keys.knowledge(scope, name);
    const status = tombstoned ? undefined : await unwrap(this.config(scope).status(scope));
    if (status && (status.state === "destroying" || status.state === "destroyed"))
      throw new KarmiError("scope.destroyed", `Scope "${scope}" has been destroyed.`);
    const head = this.db.select().from(knowledgeHead).get();
    if (head && (head.scope !== scope || head.name !== name))
      throw new KarmiError("knowledge.invalid", "Knowledge was addressed with a different Scope or name.");
    return head;
  }

  private async boundary<T>(action: () => Promise<T>): Promise<Outcome<T>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        return ok(await action());
      } catch (error) {
        return fail(error instanceof KarmiError ? error : new KarmiError("knowledge.invalid", errorMessage(error)));
      }
    });
  }

  private retriever(name: string | undefined): Retriever {
    if (name === undefined || name === "fts5") return fts5Retriever;
    const retriever = this.deployment.catalogue.retrievers.get(name);
    if (!retriever) throw new KarmiError("knowledge.invalid", `Unknown Retriever "${name}".`);
    return retriever;
  }

  private context(head: Head, retriever: Retriever, settings?: Record<string, unknown>): RetrieverContext<unknown> {
    const embedding = decodeOptions(head.options).index?.embedding;
    return attachRetrieverDatabase(
      {
        knowledge: { scope: head.scope, name: head.name },
        settings: retriever.settings ? z.parse(retriever.settings, settings ?? {}) : undefined,
        logger: bindLogger(this.deployment.logger, { scope: head.scope }),
        signal: AbortSignal.timeout(25000),
        storage: this.ctx.storage.sql,
        ...(embedding && { embedding }),
        ...(this.env.KARMI_AI && { ai: this.env.KARMI_AI }),
        search: (query, topK) => this.store.search(query, topK),
        inline: () => this.store.inline(),
      },
      this.db,
    );
  }

  /** Ingests documents, returning a pending Job for requests above the bulk threshold. */
  ingest(scope: string, name: string, input: KnowledgeDocument[], raw: KnowledgeIngestOptions) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      const docs = z.parse(knowledgeDocumentsSchema, input);
      const options = z.parse(knowledgeIngestSchema, raw);
      const saved = head ? decodeOptions(head.options) : options;
      const embedding = this.retriever(saved.retriever).embedding;
      const index = z.parse(knowledgeIndexSchema, { ...saved.index, ...(!head && embedding && { embedding }) });
      if (
        (options.index &&
          JSON.stringify(
            z.parse(knowledgeIndexSchema, { ...options.index, embedding: options.index.embedding ?? index.embedding }),
          ) !== JSON.stringify(index)) ||
        (options.retriever !== undefined && options.retriever !== (saved.retriever ?? "fts5")) ||
        (options.settings !== undefined && JSON.stringify(options.settings) !== JSON.stringify(saved.settings))
      )
        throw new KarmiError(
          "knowledge.indexConflict",
          "Chunking and indexing Retriever settings are fixed at first ingest.",
        );
      const fixed = {
        index,
        ...(saved.retriever && { retriever: saved.retriever }),
        ...(saved.settings && { settings: saved.settings }),
      };
      const target = head ?? { scope, name, options: fixed };
      this.context(target, this.retriever(fixed.retriever), fixed.settings);
      const fingerprint = await digest(JSON.stringify({ docs, fixed, threadKey: options.threadKey }));
      const id = options.jobId ?? crypto.randomUUID();
      const previous = this.db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).get();
      if (previous) {
        if (decodeRequest(previous.request).fingerprint !== fingerprint)
          throw new KarmiError("knowledge.indexConflict", "The jobId already identifies a different ingest.");
        return previous.completed === previous.total ? { indexed: previous.total } : { pending: id };
      }
      this.assertIdle();
      const callback = options.threadKey ? await openThread(this.env, scope, options.threadKey).status() : undefined;
      await unwrap(this.config(scope).knowledgeAdd(scope, name));
      await this.ctx.storage.setAlarm(this.deployment.clock.now() + 1000);
      this.stage(target, id, docs, {
        fingerprint,
        options: { ...fixed, ...options },
        ...(callback && { callbackAfter: callback.seq }),
      });
      if (docs.reduce((size, doc) => size + doc.text.length, 0) > KNOWLEDGE_BULK_THRESHOLD || docs.length > 32)
        return { pending: id };
      await this.process(target, id, docs.length);
      if (options.jobId) this.db.update(ingestJobs).set({ notified: true }).where(eq(ingestJobs.id, id)).run();
      else this.db.delete(ingestJobs).where(eq(ingestJobs.id, id)).run();
      return { indexed: docs.length };
    });
  }

  private stage(head: Head, id: string, docs: KnowledgeDocument[], request: z.output<typeof requestSchema>): void {
    this.db.transaction((tx) => {
      if (!tx.select({ scope: knowledgeHead.scope }).from(knowledgeHead).get())
        tx.insert(knowledgeHead).values(head).run();
      tx.insert(ingestJobs).values({ id, request, total: docs.length }).run();
      docs.forEach((document, seq) => tx.insert(ingestDocuments).values({ job: id, seq, document }).run());
    });
  }

  private assertIdle(includeCallbacks = false): void {
    const pending = includeCallbacks
      ? eq(ingestJobs.notified, false)
      : and(eq(ingestJobs.notified, false), lt(ingestJobs.completed, ingestJobs.total));
    if (this.db.select({ id: ingestJobs.id }).from(ingestJobs).where(pending).limit(1).get())
      throw new KarmiError(
        "knowledge.busy",
        "A Knowledge ingest is pending; wait for its Job before changing the corpus.",
      );
  }

  private async process(head: Head, id: string, limit: number): Promise<void> {
    const options = decodeOptions(head.options);
    const retriever = this.retriever(options.retriever);
    const context = this.context(head, retriever, options.settings);
    const index = options.index ?? z.parse(knowledgeIndexSchema, {});
    const rows = this.db
      .select({ seq: ingestDocuments.seq, document: ingestDocuments.document })
      .from(ingestDocuments)
      .where(eq(ingestDocuments.job, id))
      .orderBy(asc(ingestDocuments.seq))
      .limit(limit)
      .all();
    for (const row of rows) {
      const doc = z.parse(knowledgeDocumentsSchema, [row.document])[0];
      if (!doc) continue;
      const chunks = chunkDocument(doc, index);
      await retriever.delete?.([doc.id], context);
      this.store.replace(doc, chunks);
      await retriever.index?.(chunks, context);
      this.db.transaction((tx) => {
        tx.update(ingestJobs)
          .set({ completed: row.seq + 1 })
          .where(eq(ingestJobs.id, id))
          .run();
        tx.delete(ingestDocuments)
          .where(and(eq(ingestDocuments.job, id), eq(ingestDocuments.seq, row.seq)))
          .run();
      });
    }
  }

  /** Runs the next ingest batch; alarm retries repeat only unfinished document operations. */
  async alarm(): Promise<void> {
    const result = await this.boundary(async () => {
      const head = this.db.select().from(knowledgeHead).get();
      if (!head) return;
      await this.enter(head.scope, head.name);
      const job = this.db
        .select()
        .from(ingestJobs)
        .where(eq(ingestJobs.notified, false))
        .orderBy(asc(ingestJobs.id))
        .limit(1)
        .get();
      if (!job) return;
      await this.ctx.storage.setAlarm(this.deployment.clock.now() + 1000);
      await this.process(head, job.id, 8);
      const updated = this.db.select().from(ingestJobs).where(eq(ingestJobs.id, job.id)).get();
      if (!updated) throw new KarmiError("job.notFound", `No Knowledge ingest Job "${job.id}".`);
      if (updated.completed !== updated.total) return;
      await this.notify(head, updated);
      this.db.update(ingestJobs).set({ notified: true }).where(eq(ingestJobs.id, job.id)).run();
    });
    if (!result.ok) this.deployment.logger.warn("Knowledge ingest will retry.", { error: result.message });
  }

  private async notify(head: Head, job: JobRow): Promise<void> {
    const { options, callbackAfter } = decodeRequest(job.request);
    if (!options.threadKey) return;
    const thread = openThread(this.env, head.scope, options.threadKey);
    try {
      await thread.jobs.complete(job.id, {
        content: [{ type: "text", text: `Indexed ${job.total} documents into ${head.name}.` }],
      });
    } catch (error) {
      if (!(error instanceof KarmiError)) throw error;
      if (error.code === "thread.deleted" || error.code === "thread.notFound") return;
      if (error.code !== "job.notFound") throw error;
      // A completion may have reached the Thread before this object's acknowledgement was committed.
      // A missing Job is retried only while the Tool has yet to return its pending result.
      const events = await thread.events({ after: callbackAfter ?? 0 });
      if (
        events.some(
          (event) =>
            ("jobId" in event && event.jobId === job.id) ||
            event.type === "turn.completed" ||
            event.type === "turn.failed",
        )
      )
        return;
      throw error;
    }
  }

  /** Returns completed and total document counts for a durable ingest Job. */
  job(scope: string, name: string, id: string): Promise<Outcome<KnowledgeJob>> {
    return this.boundary(async () => {
      await this.enter(scope, name);
      const job = this.db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).get();
      if (!job) throw new KarmiError("job.notFound", `No Knowledge ingest Job "${id}".`);
      return {
        state: job.completed === job.total ? "completed" : "pending",
        completed: job.completed,
        total: job.total,
      };
    });
  }

  /** Searches committed chunks through the selected Retriever. */
  search(scope: string, name: string, query: string, raw: z.input<typeof searchSchema>) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      if (!head) return [];
      const saved = decodeOptions(head.options);
      const options = z.parse(searchSchema, raw);
      const retriever = this.retriever(options.retriever ?? saved.retriever);
      return retriever.search(
        z.parse(z.string(), query),
        this.context(head, retriever, options.settings ?? saved.settings),
      );
    });
  }

  /** Rebuilds the external mirror from embeddings retained in the ledger. */
  rebuild(scope: string, name: string) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      if (!head) return;
      this.assertIdle();
      const options = decodeOptions(head.options);
      const retriever = this.retriever(options.retriever);
      await retriever.rebuild?.(this.context(head, retriever, options.settings));
    });
  }

  /** Reads the corpus through the same bounded ledger view available to Retrievers. */
  inline(scope: string, name: string) {
    return this.boundary(async () => {
      await this.enter(scope, name);
      return this.store.inline();
    });
  }

  /** Deletes documents and their Retriever mirror; a retry is safe after partial failure. */
  remove(scope: string, name: string, raw: string[]) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      if (!head) return;
      this.assertIdle();
      const ids = z.parse(z.array(z.string()), raw);
      const options = decodeOptions(head.options);
      const retriever = this.retriever(options.retriever);
      await retriever.delete?.(ids, this.context(head, retriever, options.settings));
      this.db.transaction(() => this.store.remove(ids));
    });
  }

  /**
   * Clears the Retriever mirror before dropping the ledger and the Scope index entry. `during` marks a call
   * from a Scope destroy walk, which owns the index entry itself and abandons a pending ingest rather than
   * refusing.
   */
  destroy(scope: string, name: string, during?: "scope-destroy") {
    const destroying = during === "scope-destroy";
    return this.boundary(async () => {
      const head = await this.enter(scope, name, destroying);
      if (!destroying) this.assertIdle(true);
      if (head) {
        const options = decodeOptions(head.options);
        const retriever = this.retriever(options.retriever);
        const context = this.context(head, retriever, options.settings);
        let after = "";
        while (true) {
          const docs = this.db
            .select({ id: documents.id })
            .from(documents)
            .where(gt(documents.id, after))
            .orderBy(asc(documents.id))
            .limit(100)
            .all();
          const last = docs.at(-1);
          if (!last) break;
          await retriever.delete?.(
            docs.map((doc) => doc.id),
            context,
          );
          after = last.id;
        }
        await retriever.destroy?.(context);
      }
      this.store.clear();
      if (!destroying) await unwrap(this.config(scope).knowledgeRemove(scope, name));
      await this.ctx.storage.deleteAlarm();
    });
  }
}

function decodeRequest(value: unknown): z.output<typeof requestSchema> {
  return z.parse(requestSchema, value);
}
async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeOptions(value: unknown): z.output<typeof knowledgeIngestSchema> {
  return z.parse(knowledgeIngestSchema, value);
}
