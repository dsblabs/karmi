import { DurableObject } from "cloudflare:workers";
import * as z from "zod/mini";
import type { KarmiBindings } from "./bindings";
import type { Deployment } from "./deployment";
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
import type { ScopeConfigDurableObject } from "./scope-config-do";
import { openThread } from "./thread";

type Head = { scope: string; name: string; options: string };
type JobRow = { id: string; request: string; completed: number; total: number; notified: number };
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

  constructor(ctx: DurableObjectState, env: KarmiBindings) {
    super(ctx, env);
    this.store = new KnowledgeStore(ctx.storage);
  }

  private get sql(): SqlStorage {
    return this.store.sql;
  }

  private config(scope: string) {
    return remote<ScopeConfigDurableObject>(this.env.KARMI_SCOPES, keys.config(scope));
  }

  private async enter(scope: string, name: string): Promise<Head | undefined> {
    keys.knowledge(scope, name);
    const status = await unwrap(this.config(scope).status(scope));
    if (status.state === "destroying" || status.state === "destroyed")
      throw new KarmiError("scope.destroyed", `Scope "${scope}" has been destroyed.`);
    const head = this.sql.exec<Head>("SELECT * FROM knowledge_head").toArray()[0];
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
    return {
      knowledge: { scope: head.scope, name: head.name },
      settings: retriever.settings ? z.parse(retriever.settings, settings ?? {}) : undefined,
      logger: bindLogger(this.deployment.logger, { scope: head.scope }),
      signal: AbortSignal.timeout(25000),
      search: (query) => this.store.search(query),
      inline: () => this.store.inline(),
    };
  }

  /** Ingests documents, returning a pending Job for requests above the bulk threshold. */
  ingest(scope: string, name: string, input: KnowledgeDocument[], raw: KnowledgeIngestOptions) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      const docs = z.parse(knowledgeDocumentsSchema, input);
      const options = z.parse(knowledgeIngestSchema, raw);
      const saved = head ? decodeOptions(head.options) : options;
      const index = saved.index ?? z.parse(knowledgeIndexSchema, {});
      if (
        (options.index && JSON.stringify(options.index) !== JSON.stringify(index)) ||
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
      const target = head ?? { scope, name, options: JSON.stringify(fixed) };
      this.context(target, this.retriever(fixed.retriever), fixed.settings);
      const fingerprint = await digest(JSON.stringify({ docs, fixed, threadKey: options.threadKey }));
      const id = options.jobId ?? crypto.randomUUID();
      const previous = this.sql.exec<JobRow>("SELECT * FROM ingest_jobs WHERE id = ?", id).toArray()[0];
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
      if (options.jobId) this.sql.exec("UPDATE ingest_jobs SET notified = 1 WHERE id = ?", id);
      else this.sql.exec("DELETE FROM ingest_jobs WHERE id = ?", id);
      return { indexed: docs.length };
    });
  }

  private stage(head: Head, id: string, docs: KnowledgeDocument[], request: z.output<typeof requestSchema>): void {
    this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec("SELECT 1 FROM knowledge_head").toArray().length)
        this.sql.exec("INSERT INTO knowledge_head VALUES (?, ?, ?)", head.scope, head.name, head.options);
      this.sql.exec(
        "INSERT INTO ingest_jobs (id, request, total) VALUES (?, ?, ?)",
        id,
        JSON.stringify(request),
        docs.length,
      );
      docs.forEach((doc, seq) =>
        this.sql.exec("INSERT INTO ingest_documents VALUES (?, ?, ?)", id, seq, JSON.stringify(doc)),
      );
    });
  }

  private assertIdle(includeCallbacks = false): void {
    if (
      this.sql
        .exec(`SELECT 1 FROM ingest_jobs WHERE notified = 0 ${includeCallbacks ? "" : "AND completed < total"} LIMIT 1`)
        .toArray().length
    )
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
    const rows = this.sql
      .exec<{ seq: number; document: string }>(
        "SELECT seq, document FROM ingest_documents WHERE job = ? ORDER BY seq LIMIT ?",
        id,
        limit,
      )
      .toArray();
    for (const row of rows) {
      const doc = z.parse(knowledgeDocumentsSchema, [JSON.parse(row.document)])[0];
      if (!doc) continue;
      const chunks = chunkDocument(doc, index);
      this.store.replace(doc, chunks);
      await retriever.delete?.([doc.id], context);
      await retriever.index?.(chunks, context);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE ingest_jobs SET completed = ? WHERE id = ?", row.seq + 1, id);
        this.sql.exec("DELETE FROM ingest_documents WHERE job = ? AND seq = ?", id, row.seq);
      });
    }
  }

  /** Runs the next ingest batch; alarm retries repeat only unfinished document operations. */
  async alarm(): Promise<void> {
    const result = await this.boundary(async () => {
      const head = this.sql.exec<Head>("SELECT * FROM knowledge_head").toArray()[0];
      if (!head) return;
      await this.enter(head.scope, head.name);
      const job = this.sql
        .exec<JobRow>("SELECT * FROM ingest_jobs WHERE notified = 0 ORDER BY rowid LIMIT 1")
        .toArray()[0];
      if (!job) return;
      await this.ctx.storage.setAlarm(this.deployment.clock.now() + 1000);
      await this.process(head, job.id, 8);
      const updated = this.sql.exec<JobRow>("SELECT * FROM ingest_jobs WHERE id = ?", job.id).one();
      if (updated.completed !== updated.total) return;
      await this.notify(head, updated);
      this.sql.exec("UPDATE ingest_jobs SET notified = 1 WHERE id = ?", job.id);
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
      const job = this.sql.exec<JobRow>("SELECT * FROM ingest_jobs WHERE id = ?", id).toArray()[0];
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
      this.ctx.storage.transactionSync(() => this.store.remove(ids));
    });
  }

  /** Clears the Retriever mirror before dropping the ledger and Scope index entry. */
  destroy(scope: string, name: string) {
    return this.boundary(async () => {
      const head = await this.enter(scope, name);
      this.assertIdle(true);
      if (head) {
        const options = decodeOptions(head.options);
        const retriever = this.retriever(options.retriever);
        const context = this.context(head, retriever, options.settings);
        let after = "";
        while (true) {
          const docs = this.sql
            .exec<{ id: string }>("SELECT id FROM documents WHERE id > ? ORDER BY id LIMIT 100", after)
            .toArray();
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
      await unwrap(this.config(scope).knowledgeRemove(scope, name));
      await this.ctx.storage.deleteAlarm();
    });
  }
}

function decodeRequest(json: string): z.output<typeof requestSchema> {
  return z.parse(requestSchema, JSON.parse(json));
}
async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeOptions(json: string): z.output<typeof knowledgeIngestSchema> {
  return z.parse(knowledgeIngestSchema, JSON.parse(json));
}
