CREATE TABLE `global_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`env` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `space_secrets` ADD `env` text DEFAULT '{}' NOT NULL;