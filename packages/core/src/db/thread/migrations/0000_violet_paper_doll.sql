CREATE TABLE `alarms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dueAt` integer NOT NULL,
	`payload` text NOT NULL,
	`attempt` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alarms_due` ON `alarms` (`dueAt`,`id`);--> statement-breakpoint
CREATE TABLE `container_run` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `container_workspace` (
	`id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delegation_children` (
	`id` text PRIMARY KEY NOT NULL,
	`turn` integer NOT NULL,
	`released` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delegation_children_outstanding` ON `delegation_children` (`released`) WHERE "delegation_children"."released" = 0;--> statement-breakpoint
CREATE INDEX `delegation_children_by_turn` ON `delegation_children` (`turn`);--> statement-breakpoint
CREATE TABLE `delegation_origin` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delegation_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`turn` integer NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delegation_reservations_by_turn` ON `delegation_reservations` (`turn`);--> statement-breakpoint
CREATE TABLE `deleted` (
	`id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`to_seq` integer PRIMARY KEY NOT NULL,
	`from_seq` integer NOT NULL,
	`turn` integer NOT NULL,
	`binding_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deliveries_turn` ON `deliveries` (`turn`,`to_seq`);--> statement-breakpoint
CREATE TABLE `delivery_route` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`turn` integer NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_tool_calls` ON `events` (`turn`) WHERE "events"."type" = 'server_tool.called';--> statement-breakpoint
CREATE INDEX `events_turn_seq` ON `events` (`turn`,`seq`);--> statement-breakpoint
CREATE TABLE `inputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn` integer NOT NULL,
	`json` text NOT NULL,
	`steer` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`next_at` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedules_next` ON `schedules` (`next_at`);--> statement-breakpoint
CREATE TABLE `thread` (
	`scope_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text,
	`thread_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	`turn` integer NOT NULL,
	`step` integer NOT NULL,
	`attempt` integer NOT NULL,
	`recoveries` integer NOT NULL,
	`platform_failure` integer DEFAULT false NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`agent_version` integer,
	`snapshot_json` text,
	`fallback_json` text,
	`usage_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_outbox` (
	`seq` integer PRIMARY KEY NOT NULL
);
