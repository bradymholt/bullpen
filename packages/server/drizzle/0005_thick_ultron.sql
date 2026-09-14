ALTER TABLE `agents` ADD `poll_url` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `poll_headers` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `poll_path` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `poll_state` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `poll_status` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `poll_checked_at` integer;