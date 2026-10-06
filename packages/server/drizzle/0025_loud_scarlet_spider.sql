ALTER TABLE `agents` ADD `merge_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `merge_wait_seconds` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `merge_key` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `start_after` integer;