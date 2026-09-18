import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { JobKind } from "../../scheduler";

/** This table stores the Scheduler's durable alarm jobs. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text().primaryKey(),
    kind: text().$type<JobKind>().notNull(),
    dueAt: integer().notNull(),
    payload: text({ mode: "json" }).$type<unknown>().notNull(),
    attempt: integer().notNull(),
    generation: text().notNull(),
  },
  (table) => [index("jobs_due").on(table.dueAt, table.id)],
);
