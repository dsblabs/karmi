CREATE TABLE `alarms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dueAt` integer NOT NULL,
	`payload` text NOT NULL,
	`attempt` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alarms_due` ON `alarms` (`dueAt`,`id`);