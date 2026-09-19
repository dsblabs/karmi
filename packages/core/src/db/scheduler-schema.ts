import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AlarmKind } from "../scheduler";

/** This table stores the timed entries behind a Durable Object's single alarm. */
export const alarms = sqliteTable(
  "alarms",
  {
    id: text().primaryKey(),
    kind: text().$type<AlarmKind>().notNull(),
    dueAt: integer().notNull(),
    payload: text({ mode: "json" }).$type<unknown>().notNull(),
    attempt: integer().notNull(),
    generation: text().notNull(),
  },
  (table) => [index("alarms_due").on(table.dueAt, table.id)],
);
