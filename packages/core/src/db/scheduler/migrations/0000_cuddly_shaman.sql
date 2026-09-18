CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dueAt` integer NOT NULL,
	`payload` text NOT NULL,
	`attempt` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`dueAt`,`id`);