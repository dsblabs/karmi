CREATE TABLE `agent_heads` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `agent_specs` (
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`spec_json` text NOT NULL,
	`catalogue_fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `version`)
);
--> statement-breakpoint
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
CREATE TABLE `connections` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `container_leases` (
	`thread_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `destroy_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cursor_json` text
);
--> statement-breakpoint
CREATE TABLE `knowledge_names` (
	`name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_catalog` (
	`server_id` text NOT NULL,
	`partition` text NOT NULL,
	`catalog_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `partition`)
);
--> statement-breakpoint
CREATE TABLE `mcp_clients` (
	`issuer` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`secret_ref` text,
	`info_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_grants` (
	`server_id` text NOT NULL,
	`holder` text NOT NULL,
	`issuer` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` integer,
	`scope` text,
	`discovery_json` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `holder`)
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_state` (
	`nonce` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`holder` text NOT NULL,
	`user_id` text,
	`thread_json` text,
	`return_to` text,
	`verifier` text,
	`discovery_json` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`kek` text,
	`dek` text,
	`ciphertext` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `scope_head` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`current_revision` integer NOT NULL,
	`destroy_operation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scope_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_parents` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`thread_key` text NOT NULL,
	`call_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_parents_by_parent` ON `thread_parents` (`thread_key`);--> statement-breakpoint
CREATE TABLE `threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`title` text
);
--> statement-breakpoint
CREATE INDEX `threads_by_agent_user` ON `threads` (`agent_id`,`user_id`,`last_active_at`);--> statement-breakpoint
CREATE TABLE `user_connections` (
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `name`)
);
