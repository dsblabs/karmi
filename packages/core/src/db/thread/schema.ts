import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ContainerRun } from "../../container-types";
import type { DeliveryBinding } from "../../deliverer";
import type { ChildOrigin, DelegationRecord } from "../../delegation";
import type { Usage } from "../../provider";
import type { ScheduleRecord } from "../../schedule";
import type { ThreadStatus } from "../../thread";
import type { ThreadEventData, ThreadEventType, TurnInput } from "../../thread-events";
import type { TurnSnapshot } from "../../thread-do";
import type { FallbackEngaged } from "../../secrets";
import { alarms } from "../scheduler-schema";

export { alarms } from "../scheduler-schema";

/** This table stores the one container process currently owned by the Thread. */
export const containerRuns = sqliteTable("container_run", {
  id: integer().primaryKey(),
  value: text("json", { mode: "json" }).$type<ContainerRun>().notNull(),
});
/** This marker records that the Thread owns a reserved container Workspace. */
export const containerWorkspaces = sqliteTable("container_workspace", { id: integer().primaryKey() });
/** This marker makes Thread deletion durable while its asynchronous cleanup is pending. */
export const deletedThreads = sqliteTable("deleted", { id: integer().primaryKey() });
/** This table stores the Thread identity and current Turn state. */
export const threads = sqliteTable("thread", {
  scope_id: text("scope_id").notNull(),
  agent_id: text("agent_id").notNull(),
  user_id: text("user_id"),
  thread_id: text("thread_id").notNull(),
  created_at: integer("created_at").notNull(),
  state: text().$type<ThreadStatus["state"]>().notNull(),
  turn: integer().notNull(),
  step: integer().notNull(),
  attempt: integer().notNull(),
  recoveries: integer().notNull(),
  platform_failure: integer("platform_failure", { mode: "boolean" }).notNull().default(false),
  cancelled: integer({ mode: "boolean" }).notNull().default(false),
  agent_version: integer("agent_version"),
  snapshot_json: text("snapshot_json", { mode: "json" }).$type<TurnSnapshot>(),
  fallback_json: text("fallback_json", { mode: "json" }).$type<FallbackEngaged>(),
  usage_json: text("usage_json", { mode: "json" }).$type<Usage>().notNull(),
});
/** This table is the append-only Thread event log. */
export const events = sqliteTable(
  "events",
  {
    seq: integer().primaryKey(),
    turn: integer().notNull(),
    at: integer().notNull(),
    type: text().$type<ThreadEventType>().notNull(),
    json: text("json", { mode: "json" }).$type<ThreadEventData>().notNull(),
  },
  (table) => [
    index("provider_tool_calls")
      .on(table.turn)
      .where(sql`${table.type} = 'server_tool.called'`),
    index("events_turn_seq").on(table.turn, table.seq),
  ],
);
/** This table stores the offline delivery route most recently supplied by the client. */
export const deliveryRoutes = sqliteTable("delivery_route", {
  id: integer().primaryKey(),
  binding: text("json", { mode: "json" }).$type<DeliveryBinding>().notNull(),
});
/** This table stores event ranges waiting for offline delivery. */
export const deliveries = sqliteTable(
  "deliveries",
  {
    toSeq: integer("to_seq").primaryKey(),
    fromSeq: integer("from_seq").notNull(),
    turn: integer().notNull(),
    binding: text("binding_json", { mode: "json" }).$type<DeliveryBinding>().notNull(),
  },
  (table) => [index("deliveries_turn").on(table.turn, table.toSeq)],
);
/** This table queues inputs until they can join or start a Turn. */
export const inputs = sqliteTable("inputs", {
  id: integer().primaryKey({ autoIncrement: true }),
  turn: integer().notNull(),
  input: text("json", { mode: "json" }).$type<TurnInput>().notNull(),
  steer: integer({ mode: "boolean" }).notNull().default(false),
});
/** This table makes Usage delivery atomic with appending its event. */
export const usageOutbox = sqliteTable("usage_outbox", { seq: integer().primaryKey() });
/** This table stores the direct parent and ancestor chain of a Delegation child. */
export const delegationOrigins = sqliteTable("delegation_origin", {
  id: integer().primaryKey(),
  origin: text("json", { mode: "json" }).$type<ChildOrigin>().notNull(),
});
/** This table stores every Delegation child created by the Thread. */
export const delegationChildren = sqliteTable(
  "delegation_children",
  {
    id: text().primaryKey(),
    turn: integer().notNull(),
    released: integer({ mode: "boolean" }).notNull(),
    record: text("json", { mode: "json" }).$type<DelegationRecord>().notNull(),
  },
  (table) => [
    index("delegation_children_outstanding")
      .on(table.released)
      .where(sql`${table.released} = 0`),
    index("delegation_children_by_turn").on(table.turn),
  ],
);
/** This table accounts for Delegation children against each ancestor Turn's limits. */
export const delegationReservations = sqliteTable(
  "delegation_reservations",
  { id: text().primaryKey(), turn: integer().notNull(), active: integer({ mode: "boolean" }).notNull() },
  (table) => [index("delegation_reservations_by_turn").on(table.turn)],
);
/** This table stores pending one-shot and recurring Schedules. */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text().primaryKey(),
    nextAt: integer("next_at").notNull(),
    record: text("json", { mode: "json" }).$type<ScheduleRecord>().notNull(),
  },
  (table) => [index("schedules_next").on(table.nextAt)],
);

/** The complete relational schema of the Thread Durable Object. */
export const threadSchema = {
  alarms,
  containerRuns,
  containerWorkspaces,
  deletedThreads,
  threads,
  events,
  deliveryRoutes,
  deliveries,
  inputs,
  usageOutbox,
  delegationOrigins,
  delegationChildren,
  delegationReservations,
  schedules,
};
