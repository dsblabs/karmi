CREATE TABLE `vector_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`doc` text NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vector_ids_doc` ON `vector_ids` (`doc`);--> statement-breakpoint
CREATE TABLE `vectors` (
	`ns` text NOT NULL,
	`id` text NOT NULL,
	`knowledge` text NOT NULL,
	`doc` text NOT NULL,
	`values_blob` blob NOT NULL,
	PRIMARY KEY(`ns`, `id`)
);
--> statement-breakpoint
CREATE INDEX `vectors_corpus` ON `vectors` (`ns`,`knowledge`,`id`);