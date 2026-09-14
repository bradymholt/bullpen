ALTER TABLE `agents` ADD `filter_path` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `filter_values` text DEFAULT '[]' NOT NULL;