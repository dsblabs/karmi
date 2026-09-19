CREATE TABLE `vectorize_ids` (
	`ns` text NOT NULL,
	`id` text NOT NULL,
	`remote_id` text NOT NULL,
	`knowledge` text NOT NULL,
	PRIMARY KEY(`ns`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vectorize_ids_remote_unique` ON `vectorize_ids` (`ns`,`remote_id`);--> statement-breakpoint
CREATE INDEX `vectorize_ids_corpus` ON `vectorize_ids` (`ns`,`knowledge`,`id`);