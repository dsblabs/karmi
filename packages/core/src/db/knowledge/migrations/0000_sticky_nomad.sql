CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY NOT NULL,
	`doc` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`meta` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_doc_seq_unique` ON `chunks` (`doc`,`seq`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`meta` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ingest_documents` (
	`job` text NOT NULL,
	`seq` integer NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`job`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `ingest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`request` text NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`total` integer NOT NULL,
	`notified` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ingest_pending` ON `ingest_jobs` (`notified`) WHERE "ingest_jobs"."notified" = 0;--> statement-breakpoint
CREATE TABLE `knowledge_head` (
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`options` text NOT NULL
);
